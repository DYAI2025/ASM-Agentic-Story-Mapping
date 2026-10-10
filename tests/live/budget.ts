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
 * ledger past the budget, when it has no price for the model, and when there
 * is no ledger to count against. The app reads no token usage, so the ledger
 * counts bounds, never measured cost; the measured cost is in the Anthropic
 * console.
 *
 * The bound of one model call: every token of a request is at least one byte
 * of it, so the bytes of the request the adapter sends bound its input
 * tokens; to that comes the schema once more and a fixed allowance for what
 * the API adds around a structured-output request (an assumption, with the
 * bytes-for-tokens slack on top), and the whole output budget the adapter
 * asks for.
 */

/** List prices in USD per million tokens (Anthropic, as of 2026-10-06). Only the model the PO chose for ASM-34; any other is refused. */
const PRICES: Record<string, { upTo: number; base: Price; above: Price }> = {
  "claude-haiku-5-5": { upTo: 100_000, base: { input: 0.1, output: 0.5 }, above: { input: 0.5, output: 2.5 } },
};
type Price = { input: number; output: number };

/** The output budget of one structure request (`max_tokens` in the Anthropic adapter); thinking counts against it. */
export const MAX_OUTPUT_TOKENS = 16_000;

/** Longest repair problem line, in UTF-16 units: path 120 + message 240 + quoted value 160, the words around them, a count, room for redaction. */
export const MAX_REPAIR_LINE_UNITS = 700;

/** What the API may add around a structured-output request beyond its bytes: allowance in tokens, on top of the schema counted twice. */
const API_ALLOWANCE_TOKENS = 8_192;

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
  return (inputTokens * tier.input + outputTokens * tier.output) / 1_000_000;
}

export type SubmissionBound = {
  firstRequestBytes: number;
  repairRequestBytes: number;
  firstCallUsd: number;
  repairCallUsd: number;
  totalUsd: number;
};

export type SourceText = { label: string; text: string };

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * The most a submission of these sources under this product name can cost:
 * the first call, and the one repair call ASM-29 allows (the same request with
 * the largest repair section the repair request can make).
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
  return { firstRequestBytes, repairRequestBytes, firstCallUsd, repairCallUsd, totalUsd: firstCallUsd + repairCallUsd };
}

export type LiveSettings = { provider: string; model: string; ledgerFile: string; budgetUsd: number; createLedger: boolean };

/**
 * What a paid run names for itself: the model (the server's default and
 * `.env.local` do not decide what is paid for), the ledger it counts against
 * and the budget of that ledger. Anything missing refuses the run.
 */
export function liveSettings(env: Record<string, string | undefined> = process.env): LiveSettings {
  const provider = (env.ASM_AGENT_PROVIDER ?? "").trim().toLowerCase();
  const model = (env.ASM_AGENT_MODEL ?? "").trim();
  const ledgerFile = (env.ASM_LIVE_LEDGER ?? "").trim();
  const budgetText = (env.ASM_LIVE_BUDGET_USD ?? "").trim();
  const budgetUsd = Number(budgetText);
  if (!model) throw new BudgetRefusal("set ASM_AGENT_MODEL: a paid run names its model");
  if (!ledgerFile) throw new BudgetRefusal("set ASM_LIVE_LEDGER to the ledger file this budget is counted in");
  if (budgetText === "" || !Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new BudgetRefusal("set ASM_LIVE_BUDGET_USD to the budget in USD");
  return { provider, model, ledgerFile, budgetUsd, createLedger: env.ASM_LIVE_LEDGER_CREATE === "1" };
}

/** The server names the provider and model it used (`provider` in the answer); a paid run stops when that is not the one it named. */
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

type LedgerFile = { ledger: string; budgetUsd: number; currency: "USD"; createdAt: string; entries: LedgerEntry[] };

export type Ledger = {
  readonly file: string;
  readonly budgetUsd: number;
  spentUsd(): number;
  /** Reserves the whole bound of a submission and writes it down before the submission is sent. */
  reserve(bound: Pick<SubmissionBound, "firstCallUsd" | "repairCallUsd" | "totalUsd">, meta: { label: string; commit: string; model: string }): Promise<number>;
  /** Charges what the server reported: no call nothing, one call the first bound, two the first and the repair; unreported, the whole bound. */
  settle(id: number, outcome: { modelCalls: number | null; serverProvider: string | null }): Promise<void>;
  entries(): readonly LedgerEntry[];
};

/** Opens the ledger. A missing ledger is created only with `create`; a ledger made for another budget is refused. */
export async function openLedger(file: string, budgetUsd: number, options: { create?: boolean } = {}): Promise<Ledger> {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new BudgetRefusal(`the budget must be a positive number (got ${budgetUsd})`);
  let state: LedgerFile;
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null) {
    if (!options.create) throw new BudgetRefusal(`no ledger at ${file}; create it deliberately (ASM_LIVE_LEDGER_CREATE=1) rather than start from zero by accident`);
    state = { ledger: path.basename(file), budgetUsd, currency: "USD", createdAt: new Date().toISOString(), entries: [] };
    await write(file, state);
  } else {
    try {
      state = JSON.parse(text) as LedgerFile;
    } catch {
      throw new BudgetRefusal(`the ledger at ${file} is not readable JSON`);
    }
    if (!Array.isArray(state.entries) || state.currency !== "USD") throw new BudgetRefusal(`the ledger at ${file} is not a budget ledger`);
    if (state.budgetUsd !== budgetUsd) throw new BudgetRefusal(`the ledger at ${file} was made for ${state.budgetUsd} USD, not ${budgetUsd} USD`);
  }

  const spent = () => state.entries.reduce((sum, entry) => sum + entry.chargedMicroUsd, 0);
  return {
    file,
    budgetUsd,
    spentUsd: () => spent() / 1_000_000,
    entries: () => state.entries,
    async reserve(bound, meta) {
      const first = micro(bound.firstCallUsd);
      const repair = micro(bound.repairCallUsd);
      const total = Math.max(first + repair, micro(bound.totalUsd));
      if (spent() + total > micro(budgetUsd))
        throw new BudgetRefusal(
          `${meta.label}: up to ${(total / 1e6).toFixed(6)} USD on top of ${(spent() / 1e6).toFixed(6)} USD would pass the budget of ${budgetUsd} USD; not sent`,
        );
      const id = state.entries.length;
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
      state = { ...state, entries: [...state.entries, entry] };
      await write(file, state);
      return id;
    },
    async settle(id, outcome) {
      const entry = state.entries[id];
      if (!entry || entry.status !== "reserved") throw new BudgetRefusal(`no open reservation ${id} in ${file}`);
      const { first, repair, total } = entry.boundMicroUsd;
      const calls = outcome.modelCalls;
      const charged =
        calls === null || !Number.isInteger(calls) || calls < 0 ? total : calls === 0 ? 0 : calls === 1 ? first : Math.max(total, first + (calls - 1) * repair);
      const settled: LedgerEntry = { ...entry, status: "settled", modelCalls: calls, serverProvider: outcome.serverProvider, chargedMicroUsd: charged };
      state = { ...state, entries: state.entries.map((e) => (e.id === id ? settled : e)) };
      await write(file, state);
    },
  };
}

async function write(file: string, state: LedgerFile) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
}
