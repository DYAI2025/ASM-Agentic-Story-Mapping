import { promises as fs } from "node:fs";
import path from "node:path";
import { buildRequest } from "../../src/agent/anthropic-provider";
import { MAX_REPAIR_PROBLEMS } from "../../src/agent/narrative-builder";
import { blankProduct } from "../../src/domain/bootstrap";
import { PASTED_LABEL, type ContextBundle } from "../../src/domain/context";

/**
 * ASM-34, AC-6: the budget guard of the paid live runs (smoke, battery,
 * real-input intake). It fails closed: before a submission it reserves the
 * most that submission can cost, and it refuses when that would take the
 * ledger past the budget, when it has no price for the model, when there is
 * no ledger to count against or the ledger cannot be read or does not add up,
 * when another run holds the ledger, and once a run has stopped it. The app
 * reads no token usage, so the ledger counts bounds, never measured cost; the
 * measured cost is in the Anthropic console.
 *
 * The bound of one model call rests on two assumptions, stated rather than
 * proven: a token of this text-only request is at least one byte of it (for
 * prose, bytes run at about three to four times the tokens), so the bytes of
 * the request bound its input tokens; and what the API adds around a
 * structured-output request is no more than the schema once more plus a fixed
 * allowance. A request with images, files or tools would need another bound.
 * To that comes the whole output budget the adapter asks for, at the list
 * price, times the US-inference factor.
 */

/** List prices in USD per million tokens (Anthropic, as of 2026-10-06). Only the model the PO chose for ASM-34; any other is refused. */
const PRICES: Record<string, { upTo: number; base: Price; above: Price }> = {
  "claude-haiku-5-5": { upTo: 100_000, base: { input: 0.1, output: 0.5 }, above: { input: 0.5, output: 2.5 } },
};
type Price = { input: number; output: number };

/** A workspace whose default inference region is the US pays 1.1 times the list price, without the request naming it. */
const US_INFERENCE_FACTOR = 1.1;

/** The PO's ceiling for the paid runs of ASM-34 (decision 2026-10-10: at most 5 EUR, guarded at 5.00 USD). Lower budgets are allowed. */
export const MAX_BUDGET_USD = 5;

/** The output budget of one structure request (`max_tokens` in the Anthropic adapter); thinking counts against it. */
export const MAX_OUTPUT_TOKENS = 16_000;

/** Longest repair problem line, in UTF-16 units: path 120 + message 240 + quoted value 160, the words around them, a count, room for redaction. */
export const MAX_REPAIR_LINE_UNITS = 700;

/** What the API may add around a structured-output request beyond its bytes and the schema counted once more: a fixed allowance in tokens. */
export const API_ALLOWANCE_TOKENS = 8_192;

/** How long a reservation waits for another run to let go of the ledger before it refuses. */
const LOCK_WAIT_MS = 10_000;

export class BudgetRefusal extends Error {
  constructor(message: string) {
    super(`budget guard: ${message}`);
    this.name = "BudgetRefusal";
  }
}

/** The most one model call can cost, in USD. */
export function callBoundUsd(model: string, inputTokens: number, outputTokens: number = MAX_OUTPUT_TOKENS): number {
  const price = PRICES[model];
  if (!price) throw new BudgetRefusal(`no price for model ${JSON.stringify(model)}; refusing rather than guessing`);
  if (!Number.isFinite(inputTokens) || inputTokens < 0 || !Number.isFinite(outputTokens) || outputTokens < 0)
    throw new BudgetRefusal(`token bounds must be finite and not negative (input ${inputTokens}, output ${outputTokens})`);
  const tier = inputTokens > price.upTo ? price.above : price.base;
  return ((inputTokens * tier.input + outputTokens * tier.output) / 1_000_000) * US_INFERENCE_FACTOR;
}

export type SubmissionBound = {
  firstRequestBytes: number;
  repairRequestBytes: number;
  schemaBytes: number;
  firstCallUsd: number;
  repairCallUsd: number;
  totalUsd: number;
};

export type SourceText = { label: string; text: string };

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * The most a submission of these sources under this product name can cost:
 * the first call, and the one repair call ASM-29 allows (the same request with
 * the largest repair section the repair request can make). The requests are
 * built with the adapter's own `buildRequest` from the same kind of bundle the
 * app makes, not captured from the wire.
 */
export function boundForContext(model: string, name: string, sources: readonly SourceText[]): SubmissionBound {
  const blank = blankProduct(name);
  if (!blank.ok) throw new BudgetRefusal(`product name ${JSON.stringify(name)} is not one the app accepts`);
  const context: ContextBundle = {
    sources: sources.map((source, i) => ({ id: `src-${i + 1}`, label: source.label, kind: source.label === PASTED_LABEL ? "pasted" : "file", text: source.text })),
  };
  const first = buildRequest({ context, product: blank.product }, model);
  // The widest character a repair line can carry costs three bytes in one UTF-16 unit (a four-byte one takes two units).
  const worstLine = "€".repeat(MAX_REPAIR_LINE_UNITS);
  const repair = buildRequest({ context, product: blank.product, repair: { problems: Array(MAX_REPAIR_PROBLEMS).fill(worstLine), omitted: 999_999 } }, model);
  const schemaBytes = bytes(first.output_config.format.schema);
  const firstRequestBytes = bytes(first);
  const repairRequestBytes = bytes(repair);
  const firstCallUsd = callBoundUsd(model, firstRequestBytes + schemaBytes + API_ALLOWANCE_TOKENS);
  const repairCallUsd = callBoundUsd(model, repairRequestBytes + schemaBytes + API_ALLOWANCE_TOKENS);
  return { firstRequestBytes, repairRequestBytes, schemaBytes, firstCallUsd, repairCallUsd, totalUsd: firstCallUsd + repairCallUsd };
}

export type LiveSettings = { provider: string; model: string; ledgerFile: string; budgetUsd: number; createLedger: boolean };

/**
 * What a paid run names for itself: the model (the server's default and
 * `.env.local` do not decide what is paid for), the ledger it counts against
 * and the budget of that ledger, at most the PO's ceiling. Anything missing
 * refuses the run.
 */
export function liveSettings(env: Record<string, string | undefined> = process.env): LiveSettings {
  const provider = (env.ASM_AGENT_PROVIDER ?? "").trim().toLowerCase();
  const model = (env.ASM_AGENT_MODEL ?? "").trim();
  const ledgerFile = (env.ASM_LIVE_LEDGER ?? "").trim();
  const budgetText = (env.ASM_LIVE_BUDGET_USD ?? "").trim();
  const budgetUsd = Number(budgetText);
  if (!model) throw new BudgetRefusal("set ASM_AGENT_MODEL: a paid run names its model");
  if (!ledgerFile) throw new BudgetRefusal("set ASM_LIVE_LEDGER to the ledger file this budget is counted in");
  checkBudget(budgetText === "" ? Number.NaN : budgetUsd);
  return { provider, model, ledgerFile, budgetUsd, createLedger: env.ASM_LIVE_LEDGER_CREATE === "1" };
}

function checkBudget(budgetUsd: number) {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new BudgetRefusal("set ASM_LIVE_BUDGET_USD to the budget in USD, a positive number");
  if (budgetUsd > MAX_BUDGET_USD) throw new BudgetRefusal(`a budget of ${budgetUsd} USD is above the PO's ceiling of ${MAX_BUDGET_USD} USD`);
}

/** The server names the provider and model it was configured to request (`provider` in the answer); a paid run stops when that is not the one it named. */
export function expectServerModel(provider: string, model: string, serverProvider: string | null, modelCalls: number | null) {
  if (modelCalls === 0 && serverProvider === null) return;
  const expected = `${provider} (${model})`;
  if (serverProvider !== expected)
    throw new Error(`the server answered as ${JSON.stringify(serverProvider)} after ${modelCalls ?? "an unknown number of"} model call(s), not as ${expected}; stopping`);
}

type Micro = number;
const micro = (usd: number): Micro => Math.ceil(usd * 1_000_000);

export type LedgerEntry = {
  id: number;
  at: string;
  label: string;
  commit: string;
  model: string;
  status: "reserved" | "settled";
  boundMicroUsd: { first: Micro; repair: Micro; total: Micro };
  modelCalls: number | null;
  serverProvider: string | null;
  chargedMicroUsd: Micro;
};

type LedgerFile = { ledger: string; budgetUsd: number; currency: "USD"; createdAt: string; stoppedReason?: string; entries: LedgerEntry[] };

export type Ledger = {
  readonly file: string;
  readonly budgetUsd: number;
  /** What the ledger held when this run last read or wrote it. */
  spentUsd(): number;
  entries(): readonly LedgerEntry[];
  /** Reserves the whole bound of a submission and writes it down before the submission is sent, against the ledger as it is on disk. */
  reserve(bound: Pick<SubmissionBound, "firstCallUsd" | "repairCallUsd" | "totalUsd">, meta: { label: string; commit: string; model: string }, options?: { lockWaitMs?: number }): Promise<number>;
  /**
   * Charges what the server reported: no call nothing, one call the first bound, two the first and the repair, each
   * further call the repair bound; unreported, or `wholeBound`, the whole bound (never less than the reservation's parts).
   */
  settle(id: number, outcome: { modelCalls: number | null; serverProvider: string | null; wholeBound?: boolean }): Promise<void>;
  /** Stops the ledger: no further submission is reserved until a human removes `stoppedReason` from the file. */
  stop(reason: string): Promise<void>;
};

const isMicro = (value: unknown): value is Micro => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The ledger as it is on disk, checked entry by entry; null when there is no file. Anything else that does not read or add up is refused. */
async function readLedger(file: string, budgetUsd: number): Promise<LedgerFile | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new BudgetRefusal(`the ledger at ${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)}); refusing rather than starting from zero`);
  }
  let state: LedgerFile;
  try {
    state = JSON.parse(text) as LedgerFile;
  } catch {
    throw new BudgetRefusal(`the ledger at ${file} is not readable JSON`);
  }
  const bad = (why: string) => new BudgetRefusal(`the ledger at ${file} does not add up: ${why}; refusing rather than counting it as nothing`);
  if (typeof state !== "object" || state === null || !Array.isArray(state.entries) || state.currency !== "USD") throw bad("not a budget ledger");
  if (state.budgetUsd !== budgetUsd) throw new BudgetRefusal(`the ledger at ${file} was made for ${state.budgetUsd} USD, not ${budgetUsd} USD`);
  if (state.stoppedReason !== undefined && typeof state.stoppedReason !== "string") throw bad("stoppedReason is not text");
  state.entries.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null) throw bad(`entry ${i} is not an entry`);
    if (entry.id !== i) throw bad(`entry ${i} has id ${JSON.stringify(entry.id)}`);
    if (entry.status !== "reserved" && entry.status !== "settled") throw bad(`entry ${i} has status ${JSON.stringify(entry.status)}`);
    const b = entry.boundMicroUsd;
    if (!b || !isMicro(b.first) || !isMicro(b.repair) || !isMicro(b.total) || b.total < b.first + b.repair) throw bad(`entry ${i} has a bound whose parts do not add up`);
    if (!isMicro(entry.chargedMicroUsd)) throw bad(`entry ${i} has no charge in whole micro-dollars`);
    if (entry.status === "reserved" && entry.chargedMicroUsd !== b.total) throw bad(`entry ${i} is reserved for less than its bound`);
    const calls = entry.modelCalls;
    if (entry.status === "settled") {
      if (calls === null && entry.chargedMicroUsd < b.total) throw bad(`entry ${i} reported no call count and is charged less than its bound`);
      if (calls !== null && (!Number.isInteger(calls) || calls < 0)) throw bad(`entry ${i} has a call count that is not a whole number`);
      if (typeof calls === "number" && calls >= 1 && entry.chargedMicroUsd < b.first) throw bad(`entry ${i} made calls and is charged less than one`);
    }
  });
  return state;
}

/** Runs `work` while this run alone holds the ledger: a lock file created exclusively beside it, removed afterwards. */
async function withLock<T>(file: string, waitMs: number, work: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  let handle: fs.FileHandle | null = null;
  while (!handle) {
    try {
      handle = await fs.open(lock, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new BudgetRefusal(`cannot take the ledger lock ${lock} (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
      if (Date.now() >= deadline) throw new BudgetRefusal(`the ledger is held by another run (lock ${lock}); if no paid run is going on, remove the lock file after looking`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
    return await work();
  } finally {
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}

/** Opens the ledger. A missing ledger is created only with `create`; a ledger made for another budget, or one that cannot be read or does not add up, is refused. */
export async function openLedger(file: string, budgetUsd: number, options: { create?: boolean; lockWaitMs?: number } = {}): Promise<Ledger> {
  checkBudget(budgetUsd);
  let state = await withLock(file, options.lockWaitMs ?? LOCK_WAIT_MS, async () => {
    const found = await readLedger(file, budgetUsd);
    if (found) return found;
    if (!options.create) throw new BudgetRefusal(`no ledger at ${file}; create it deliberately (ASM_LIVE_LEDGER_CREATE=1) rather than start from zero by accident`);
    const created: LedgerFile = { ledger: path.basename(file), budgetUsd, currency: "USD", createdAt: new Date().toISOString(), entries: [] };
    await write(file, created);
    return created;
  });

  /** Reads the ledger on disk under the lock, applies a change, writes it back: another run's reservations count, and none is lost. */
  const update = <T>(waitMs: number, change: (current: LedgerFile) => { next: LedgerFile; result: T }) =>
    withLock(file, waitMs, async () => {
      const current = await readLedger(file, budgetUsd);
      if (!current) throw new BudgetRefusal(`the ledger at ${file} is gone`);
      const { next, result } = change(current);
      if (next !== current) await write(file, next);
      state = next;
      return result;
    });
  const spent = (s: LedgerFile) => s.entries.reduce((sum, entry) => sum + entry.chargedMicroUsd, 0);

  return {
    file,
    budgetUsd,
    spentUsd: () => spent(state) / 1_000_000,
    entries: () => state.entries,
    reserve: (bound, meta, reserveOptions = {}) =>
      update(reserveOptions.lockWaitMs ?? LOCK_WAIT_MS, (current) => {
        if (current.stoppedReason)
          throw new BudgetRefusal(`the ledger is stopped (${current.stoppedReason}); a human removes "stoppedReason" from ${file} after looking`);
        const first = micro(bound.firstCallUsd);
        const repair = micro(bound.repairCallUsd);
        const total = Math.max(first + repair, micro(bound.totalUsd));
        if (spent(current) + total > micro(budgetUsd))
          throw new BudgetRefusal(
            `${meta.label}: up to ${(total / 1e6).toFixed(6)} USD on top of ${(spent(current) / 1e6).toFixed(6)} USD would pass the budget of ${budgetUsd} USD; not sent`,
          );
        const id = current.entries.length;
        const entry: LedgerEntry = {
          id,
          at: new Date().toISOString(),
          ...meta,
          status: "reserved",
          boundMicroUsd: { first, repair, total },
          modelCalls: null,
          serverProvider: null,
          chargedMicroUsd: total,
        };
        return { next: { ...current, entries: [...current.entries, entry] }, result: id };
      }),
    settle: (id, outcome) =>
      update(LOCK_WAIT_MS, (current) => {
        const entry = current.entries[id];
        if (!entry || entry.status !== "reserved") throw new BudgetRefusal(`no open reservation ${id} in ${file}`);
        const { first, repair, total } = entry.boundMicroUsd;
        const calls = outcome.modelCalls;
        const charged =
          outcome.wholeBound || calls === null || !Number.isInteger(calls) || calls < 0
            ? Math.max(total, typeof calls === "number" && calls > 2 ? first + (calls - 1) * repair : 0)
            : calls === 0
              ? 0
              : calls === 1
                ? first
                : Math.max(total, first + (calls - 1) * repair);
        const settled: LedgerEntry = { ...entry, status: "settled", modelCalls: calls, serverProvider: outcome.serverProvider, chargedMicroUsd: charged };
        return { next: { ...current, entries: current.entries.map((e) => (e.id === id ? settled : e)) }, result: undefined };
      }),
    stop: (reason) =>
      update(LOCK_WAIT_MS, (current) => ({ next: current.stoppedReason ? current : { ...current, stoppedReason: reason }, result: undefined })),
  };
}

async function write(file: string, state: LedgerFile) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
}
