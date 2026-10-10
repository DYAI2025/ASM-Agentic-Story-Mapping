import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRequest } from "../../src/agent/anthropic-provider";
import { repairRequest } from "../../src/agent/narrative-builder";
import { blankProduct } from "../../src/domain/bootstrap";
import { bundleFromTranscript } from "../../src/domain/context";
import {
  API_ALLOWANCE_TOKENS,
  BudgetRefusal,
  MAX_BUDGET_USD,
  MAX_OUTPUT_TOKENS,
  MAX_REPAIR_LINE_UNITS,
  boundForContext,
  callBoundUsd,
  expectServerModel,
  liveSettings,
  openLedger,
  withLedgerLock,
} from "../live/budget";

/**
 * ASM-34, AC-6: the paid live runs (smoke, battery, real-input intake) go
 * through a budget guard that fails closed. Before a submission it takes the
 * most the submission can cost; it refuses when that would take the ledger
 * past the budget, when it does not know the model's price, and when there is
 * no ledger to count against. The ledger keeps what was reserved even when a
 * run dies before it can settle.
 */
const MODEL = "claude-haiku-5-5";

// A workspace whose default inference region is the US pays 1.1 times the list price without the request saying so.
const US = 1.1;

describe("the most one model call can cost", () => {
  it("is the input bound at the input price plus the full output budget at the output price, times the US-inference factor", () => {
    // claude-haiku-5-5 list price for prompts up to 100k tokens: $0.10 / $0.50 per million tokens.
    expect(callBoundUsd(MODEL, 50_000)).toBeCloseTo((50_000 * 0.1e-6 + 16_000 * 0.5e-6) * US, 12);
  });

  it("uses the long-prompt price for both sides once the input bound passes 100k tokens", () => {
    expect(callBoundUsd(MODEL, 100_000)).toBeCloseTo((100_000 * 0.1e-6 + 16_000 * 0.5e-6) * US, 12);
    expect(callBoundUsd(MODEL, 100_001)).toBeCloseTo((100_001 * 0.5e-6 + 16_000 * 2.5e-6) * US, 12);
  });

  it("counts the output budget the adapter actually asks for", () => {
    const request = buildRequest({ context: bundleFromTranscript("x"), product: okProduct() }, MODEL);
    expect(MAX_OUTPUT_TOKENS).toBe(request.max_tokens);
  });

  it("refuses a model it has no price for, instead of guessing", () => {
    expect(() => callBoundUsd("claude-opus-5-5", 1000)).toThrow(BudgetRefusal);
    expect(() => callBoundUsd("", 1000)).toThrow(BudgetRefusal);
  });

  it("refuses an input bound that is not a finite, non-negative number", () => {
    expect(() => callBoundUsd(MODEL, Number.NaN)).toThrow(BudgetRefusal);
    expect(() => callBoundUsd(MODEL, -1)).toThrow(BudgetRefusal);
  });
});

describe("the most one submission can cost", () => {
  const sources = [{ label: "Pasted text", text: "Kick-off: residents miss parcels. Maya wants lockers. Ünïcödé €€€." }];

  it("bounds the first call by the bytes of the request the adapter would send", () => {
    const bound = boundForContext(MODEL, "RotaCare", sources);
    const request = buildRequest({ context: bundleFromTranscript(sources[0].text), product: okProduct("RotaCare") }, MODEL);
    // Every token is at least one byte of the request, so its bytes bound its tokens.
    expect(bound.firstRequestBytes).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(request), "utf8"));
  });

  it("bounds the repair call above the first: the same request plus the largest repair section", () => {
    const bound = boundForContext(MODEL, "RotaCare", sources);
    expect(bound.repairRequestBytes).toBeGreaterThan(bound.firstRequestBytes);
    expect(bound.repairCallUsd).toBeGreaterThan(bound.firstCallUsd);
    expect(bound.totalUsd).toBeCloseTo(bound.firstCallUsd + bound.repairCallUsd, 12);
  });

  it("adds the schema and a fixed allowance on top of the request bytes, for both calls", () => {
    // The README names the allowance; this keeps the two the same.
    expect(API_ALLOWANCE_TOKENS).toBe(8_192);
    const bound = boundForContext(MODEL, "RotaCare", sources);
    expect(bound.schemaBytes).toBeGreaterThan(1_000);
    expect(bound.firstCallUsd).toBe(callBoundUsd(MODEL, bound.firstRequestBytes + bound.schemaBytes + API_ALLOWANCE_TOKENS));
    expect(bound.repairCallUsd).toBe(callBoundUsd(MODEL, bound.repairRequestBytes + bound.schemaBytes + API_ALLOWANCE_TOKENS));
  });

  it("bounds the repair section at its widest: every line at full length, three bytes a character", () => {
    const bound = boundForContext(MODEL, "RotaCare", sources);
    expect(bound.repairRequestBytes - bound.firstRequestBytes).toBeGreaterThanOrEqual(20 * MAX_REPAIR_LINE_UNITS * 3);
  });

  it("grows with the input: a longer text has a higher bound", () => {
    const short = boundForContext(MODEL, "RotaCare", sources);
    const long = boundForContext(MODEL, "RotaCare", [{ label: "Pasted text", text: "word ".repeat(10_000) }]);
    expect(long.firstCallUsd).toBeGreaterThan(short.firstCallUsd);
  });

  it("counts every file next to the pasted text", () => {
    const one = boundForContext(MODEL, "RotaCare", sources);
    const two = boundForContext(MODEL, "RotaCare", [...sources, { label: "notes.md", text: "z".repeat(5_000) }]);
    expect(two.firstRequestBytes - one.firstRequestBytes).toBeGreaterThanOrEqual(5_000);
  });

  it("assumes no repair line longer than the repair request can make, whatever the issues say", () => {
    const long = "€".repeat(5_000);
    const previous = { personas: Array.from({ length: 30 }, () => ({ source: { snippet: long } })) };
    const issues = Array.from({ length: 30 }, (_, i) => ({ code: "snippet_not_in_source", path: `personas[${i}].source.snippet${"x".repeat(i)}`, message: long }));
    for (const line of repairRequest(issues, previous).problems) expect(line.length).toBeLessThanOrEqual(MAX_REPAIR_LINE_UNITS);
    const shape = Array.from({ length: 30 }, (_, i) => ({ code: "agent_output_invalid", path: `${long}${i}`, message: long }));
    for (const line of repairRequest(shape).problems) expect(line.length).toBeLessThanOrEqual(MAX_REPAIR_LINE_UNITS);
  });
});

describe("the ledger", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "asm-budget-")));
    file = path.join(dir, "ledger.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const bound = (total: number) => ({ firstCallUsd: total / 4, repairCallUsd: (total * 3) / 4, totalUsd: total });
  // Charges are rounded up to the micro-dollar, each part on its own: never less than the bound, at most 2 µUSD
  // more per submission (these tests make at most four).
  const expectCharged = (actual: number, usd: number) => {
    expect(actual).toBeGreaterThanOrEqual(usd);
    expect(actual).toBeLessThanOrEqual(usd + 2e-6 * 4);
  };
  const meta = { label: "A2", commit: "abc", model: MODEL };

  it("is not created by accident: a missing ledger refuses", async () => {
    await expect(openLedger(file, 5)).rejects.toThrow(BudgetRefusal);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("is created only when asked, starting at zero with its budget written down", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    expect(ledger.spentUsd()).toBe(0);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ budgetUsd: 5, currency: "USD", entries: [] });
  });

  it("refuses to be opened with a different budget than the one it was created with", async () => {
    await openLedger(file, 5, { create: true });
    await expect(openLedger(file, 6)).rejects.toThrow(BudgetRefusal);
  });

  it("reserves the whole bound before a submission, and that reservation is on disk", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    await ledger.reserve(bound(0.4), meta);
    expectCharged(ledger.spentUsd(), 0.4);
    // A run that dies here has still paid for the most it could have spent.
    const reopened = await openLedger(file, 5);
    expectCharged(reopened.spentUsd(), 0.4);
  });

  it("refuses a submission that could take it past the budget, and writes nothing for it", async () => {
    const ledger = await openLedger(file, 1, { create: true });
    await ledger.reserve(bound(0.7), meta);
    const before = await fs.readFile(file, "utf8");
    await expect(ledger.reserve(bound(0.31), meta)).rejects.toThrow(BudgetRefusal);
    expect(await fs.readFile(file, "utf8")).toBe(before);
    expectCharged(ledger.spentUsd(), 0.7);
  });

  it("allows a submission that takes it exactly to the budget", async () => {
    const ledger = await openLedger(file, 1, { create: true });
    await ledger.reserve(bound(0.5), meta);
    await expect(ledger.reserve(bound(0.5), meta)).resolves.toBeDefined();
  });

  // The charge only ever goes up (review round 2 on e4fb12a): a submission keeps its whole reservation whatever the
  // server reports, so no settlement can give headroom back.
  it("settling records what the server reported and never lowers the charge", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    for (const modelCalls of [1, 2, null, 0]) {
      const id = await ledger.reserve(bound(0.4), meta);
      await ledger.settle(id, { modelCalls, serverProvider: modelCalls ? `anthropic (${MODEL})` : null });
      expect(ledger.entries()[id]).toMatchObject({ status: "settled", modelCalls });
    }
    expectCharged(ledger.spentUsd(), 1.6);
    expectCharged((await openLedger(file, 5)).spentUsd(), 1.6);
  });

  it("charges more than the bound for a call count it did not expect: every call beyond the first at the repair bound", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    const odd = await ledger.reserve(bound(0.4), meta);
    await ledger.settle(odd, { modelCalls: 3, serverProvider: null });
    // first 0.1 + two more calls at 0.3 each.
    expectCharged(ledger.spentUsd(), 0.7);
  });

  it("stops in the same write that settles, when asked to", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    const id = await ledger.reserve(bound(0.4), meta);
    await ledger.settle(id, { modelCalls: 1, serverProvider: "anthropic (claude-opus-5-5)", stop: "another model answered" });
    const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
    expect(onDisk.stoppedReason).toBe("another model answered");
    expect(onDisk.entries[0]).toMatchObject({ status: "settled", serverProvider: "anthropic (claude-opus-5-5)" });
    await expect(ledger.reserve(bound(0.1), meta)).rejects.toThrow(/stopped/);
  });

  // Review round 4 on e2ce76e: a write replaces the file by renaming, which would replace a link and leave the
  // ledger it pointed to without the reservation.
  it("refuses a ledger reached through a symbolic link", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    await ledger.reserve(bound(0.4), meta);
    const alias = path.join(dir, "alias.json");
    await fs.symlink(file, alias);
    await expect(openLedger(alias, 5)).rejects.toThrow(BudgetRefusal);
    await expect(openLedger(alias, 5, { create: true })).rejects.toThrow(BudgetRefusal);
    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
    expectCharged((await openLedger(file, 5)).spentUsd(), 0.4);
  });

  it("keeps an existing ledger when it is asked to create one", async () => {
    const first = await openLedger(file, 5, { create: true });
    await first.reserve(bound(0.4), meta);
    const again = await openLedger(file, 5, { create: true });
    expectCharged(again.spentUsd(), 0.4);
    expect(again.entries()).toHaveLength(1);
  });

  it("refuses a ledger it cannot read, even when asked to create one, and leaves it as it was", async () => {
    if (process.getuid?.() === 0) return; // root reads any file
    const ledger = await openLedger(file, 5, { create: true });
    await ledger.reserve(bound(0.4), meta);
    const before = await fs.readFile(file, "utf8");
    await fs.chmod(file, 0o000);
    try {
      await expect(openLedger(file, 5, { create: true })).rejects.toThrow(BudgetRefusal);
    } finally {
      await fs.chmod(file, 0o600);
    }
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it.each<[string, (entry: Record<string, unknown>) => unknown]>([
    ["a charge that is missing", ({ chargedMicroUsd: _drop, ...rest }) => rest],
    ["a negative charge", (entry) => ({ ...entry, chargedMicroUsd: -1 })],
    ["a charge that is not a whole number of micro-dollars", (entry) => ({ ...entry, chargedMicroUsd: 1.5 })],
    ["a reservation charged less than its bound", (entry) => ({ ...entry, chargedMicroUsd: 1 })],
    ["a settled entry charged less than its bound", (entry) => ({ ...entry, status: "settled", modelCalls: 2, chargedMicroUsd: (entry.boundMicroUsd as { first: number }).first })],
    ["a settled entry with more calls charged less than they cost", (entry) => ({ ...entry, status: "settled", modelCalls: 5, chargedMicroUsd: (entry.boundMicroUsd as { total: number }).total })],
    ["a call count that is not a whole number", (entry) => ({ ...entry, status: "settled", modelCalls: 1.5 })],
    // Review round 3 on 198b1f9: a bound below what one call of the entry's model can cost at least (its output budget).
    ["bounds of zero", (entry) => ({ ...entry, status: "settled", modelCalls: 2, boundMicroUsd: { first: 0, repair: 0, total: 0 }, chargedMicroUsd: 0 })],
    ["a model the guard has no price for", (entry) => ({ ...entry, model: "claude-opus-5-5" })],
    ["a bound whose parts do not add up", (entry) => ({ ...entry, boundMicroUsd: { first: 10, repair: 10, total: 5 } })],
    // The same rule alone: everything else about this entry is in order (verifier round 3, OWNA).
    ["a total below its parts, nothing else wrong", (entry) => ({ ...entry, boundMicroUsd: { first: 20_000, repair: 20_000, total: 30_000 }, chargedMicroUsd: 30_000 })],
    ["an unknown status", (entry) => ({ ...entry, status: "paid" })],
    ["an id out of order", (entry) => ({ ...entry, id: 7 })],
  ])("refuses a ledger with %s, instead of counting it as nothing", async (_name, spoil) => {
    const ledger = await openLedger(file, 5, { create: true });
    await ledger.reserve(bound(0.4), meta);
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    state.entries[0] = spoil(state.entries[0]);
    await fs.writeFile(file, JSON.stringify(state));
    await expect(openLedger(file, 5)).rejects.toThrow(BudgetRefusal);
    await expect(ledger.reserve(bound(0.1), meta)).rejects.toThrow(BudgetRefusal);
  });

  it("refuses a budget above the PO's ceiling, and takes any budget up to it", async () => {
    expect(MAX_BUDGET_USD).toBe(5);
    await expect(openLedger(file, 5.01, { create: true })).rejects.toThrow(BudgetRefusal);
    await expect(fs.access(file)).rejects.toThrow();
    await expect(openLedger(file, 2, { create: true })).resolves.toBeDefined();
  });

  it("counts what another run reserved after it was opened: every reservation reads the ledger on disk", async () => {
    const one = await openLedger(file, 1, { create: true });
    const other = await openLedger(file, 1);
    await one.reserve(bound(0.6), meta);
    await expect(other.reserve(bound(0.6), meta)).rejects.toThrow(BudgetRefusal);
    expectCharged((await openLedger(file, 1)).spentUsd(), 0.6);
  });

  it("refuses while another run holds the ledger, and touches nothing", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    const before = await fs.readFile(file, "utf8");
    await fs.writeFile(`${file}.lock`, "held by another run");
    try {
      await expect(ledger.reserve(bound(0.1), meta, { lockWaitMs: 200 })).rejects.toThrow(/lock/);
      expect(await fs.readFile(file, "utf8")).toBe(before);
      expect(await fs.readFile(`${file}.lock`, "utf8")).toBe("held by another run");
    } finally {
      await fs.rm(`${file}.lock`, { force: true });
    }
    await expect(ledger.reserve(bound(0.1), meta)).resolves.toBeDefined();
    await expect(fs.access(`${file}.lock`)).rejects.toThrow();
  });

  it("lets only one of two runs reserving at the same moment take headroom both cannot have", async () => {
    // Two handles on one ledger, as two runs would hold: the lock has to cover reading, checking and writing.
    for (let round = 0; round < 5; round++) {
      await fs.rm(file, { force: true });
      const one = await openLedger(file, 1, { create: true });
      const other = await openLedger(file, 1);
      const results = await Promise.allSettled([one.reserve(bound(0.6), meta), other.reserve(bound(0.6), meta)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
      expect(onDisk.entries).toHaveLength(1);
    }
  });

  it("writes every change while it still holds the lock", async () => {
    const lock = `${file}.lock`;
    const held: boolean[] = [];
    const onWrite = async () => {
      held.push(await fs.access(lock).then(() => true, () => false));
    };
    const ledger = await openLedger(file, 5, { create: true, onWrite });
    const id = await ledger.reserve(bound(0.4), meta);
    await ledger.settle(id, { modelCalls: 1, serverProvider: `anthropic (${MODEL})` });
    await ledger.stop("checked");
    expect(held).toEqual([true, true, true, true]);
  });

  it("refuses a bound below what one call of the model costs at least, and writes nothing (verifier round 4, Q2)", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    const before = await fs.readFile(file, "utf8");
    await expect(ledger.reserve({ firstCallUsd: 0.001, repairCallUsd: 0.5, totalUsd: 0.501 }, meta)).rejects.toThrow(/at least/);
    await expect(ledger.reserve({ firstCallUsd: 0.5, repairCallUsd: 0.001, totalUsd: 0.501 }, meta)).rejects.toThrow(/at least/);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("refuses a bound that is not a finite, non-negative amount, and writes nothing", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    const before = await fs.readFile(file, "utf8");
    for (const spoiled of [
      { firstCallUsd: Number.NaN, repairCallUsd: 0.1, totalUsd: 0.2 },
      { firstCallUsd: 0.1, repairCallUsd: -0.1, totalUsd: 0 },
      { firstCallUsd: 0.1, repairCallUsd: 0.1, totalUsd: Number.POSITIVE_INFINITY },
    ])
      await expect(ledger.reserve(spoiled, meta)).rejects.toThrow(BudgetRefusal);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it.each([null, false, 0, ""])("refuses a ledger whose stoppedReason is %s: a stop is text, or it is not there", async (value) => {
    await openLedger(file, 5, { create: true });
    const state = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...state, stoppedReason: value }));
    await expect(openLedger(file, 5)).rejects.toThrow(BudgetRefusal);
  });

  it("does not remove a lock it no longer holds", async () => {
    const lock = `${file}.lock`;
    await withLedgerLock(file, 1_000, async () => {
      // A human removed this run's lock and another run took a new one meanwhile.
      await fs.writeFile(lock, "another run's lock");
    });
    expect(await fs.readFile(lock, "utf8")).toBe("another run's lock");
    await fs.rm(lock, { force: true });
  });

  it("takes no submission while a stop file lies beside it, whatever the ledger itself says", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    await fs.writeFile(`${file}.stop`, "the server answered as another model");
    await expect(ledger.reserve(bound(0.1), meta)).rejects.toThrow(/stopped/);
    await expect((await openLedger(file, 5)).reserve(bound(0.1), meta)).rejects.toThrow(/stopped/);
    expect(JSON.parse(await fs.readFile(file, "utf8")).entries).toEqual([]);
    await fs.rm(`${file}.stop`);
    await expect(ledger.reserve(bound(0.1), meta)).resolves.toBeDefined();
  });

  it("takes no submission once it is stopped, not even after it is opened again", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    await ledger.stop("the server answered as anthropic (claude-opus-5-5)");
    await expect(ledger.reserve(bound(0.1), meta)).rejects.toThrow(/stopped/);
    await expect((await openLedger(file, 5)).reserve(bound(0.1), meta)).rejects.toThrow(/stopped/);
    expect(JSON.parse(await fs.readFile(file, "utf8")).entries).toEqual([]);
  });

  it("counts a refused submission's reservation as soon as the next one asks", async () => {
    const ledger = await openLedger(file, 0.5, { create: true });
    await ledger.reserve(bound(0.3), meta);
    // Never settled: still counted in full.
    await expect(ledger.reserve(bound(0.3), meta)).rejects.toThrow(BudgetRefusal);
  });
});

describe("a paid run's settings", () => {
  const env = { ASM_AGENT_PROVIDER: "anthropic", ASM_AGENT_MODEL: MODEL, ASM_LIVE_LEDGER: "/tmp/ledger.json", ASM_LIVE_BUDGET_USD: "5" };

  // Review round 3 on 198b1f9: the prices are Anthropic's, for Anthropic's own endpoint.
  it("refuse a provider the prices are not for, even with the same model name", () => {
    for (const provider of ["openai", "openrouter", "fake", ""]) expect(() => liveSettings({ ...env, ASM_AGENT_PROVIDER: provider })).toThrow(BudgetRefusal);
  });

  it("refuse another endpoint than Anthropic's own", () => {
    expect(() => liveSettings({ ...env, ANTHROPIC_BASE_URL: "https://proxy.example.com" })).toThrow(BudgetRefusal);
  });

  it("name the model, the ledger and the budget explicitly", () => {
    expect(liveSettings(env)).toEqual({ provider: "anthropic", model: MODEL, ledgerFile: "/tmp/ledger.json", budgetUsd: 5, createLedger: false });
    expect(liveSettings({ ...env, ASM_LIVE_LEDGER_CREATE: "1" }).createLedger).toBe(true);
  });

  it("refuse a run without a model of its own: neither the code's default nor .env.local decides what is paid for", () => {
    expect(() => liveSettings({ ...env, ASM_AGENT_MODEL: "" })).toThrow(BudgetRefusal);
    expect(() => liveSettings({ ...env, ASM_AGENT_MODEL: undefined })).toThrow(BudgetRefusal);
  });

  it("refuse a run without a ledger or without a positive budget, or with a budget above the PO's ceiling", () => {
    expect(() => liveSettings({ ...env, ASM_LIVE_LEDGER: undefined })).toThrow(BudgetRefusal);
    for (const budget of [undefined, "", "0", "-1", "five", "5.01", "6"]) expect(() => liveSettings({ ...env, ASM_LIVE_BUDGET_USD: budget })).toThrow(BudgetRefusal);
    expect(liveSettings({ ...env, ASM_LIVE_BUDGET_USD: "4.5" }).budgetUsd).toBe(4.5);
  });
});

describe("the model the server says it used", () => {
  it("has to be the model the run named", () => {
    expect(() => expectServerModel("anthropic", MODEL, `anthropic (${MODEL})`, 1)).not.toThrow();
    expect(() => expectServerModel("anthropic", MODEL, "anthropic (claude-opus-5-5)", 1)).toThrow(/claude-opus-5-5/);
    expect(() => expectServerModel("anthropic", MODEL, `openrouter (${MODEL})`, 2)).toThrow();
  });

  it("has to be named whenever a call was made", () => {
    expect(() => expectServerModel("anthropic", MODEL, null, 1)).toThrow();
    expect(() => expectServerModel("anthropic", MODEL, null, null)).toThrow();
    // No call, nothing to name: a refusal before the provider was asked.
    expect(() => expectServerModel("anthropic", MODEL, null, 0)).not.toThrow();
  });
});

function okProduct(name = "Test") {
  const blank = blankProduct(name);
  if (!blank.ok) throw new Error("blank product");
  return blank.product;
}
