import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRequest } from "../../src/agent/anthropic-provider";
import { repairRequest } from "../../src/agent/narrative-builder";
import { blankProduct } from "../../src/domain/bootstrap";
import { bundleFromTranscript } from "../../src/domain/context";
import {
  BudgetRefusal,
  MAX_OUTPUT_TOKENS,
  MAX_REPAIR_LINE_UNITS,
  boundForContext,
  callBoundUsd,
  expectServerModel,
  liveSettings,
  openLedger,
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

describe("the most one model call can cost", () => {
  it("is the input bound at the input price plus the full output budget at the output price", () => {
    // claude-haiku-5-5 list price for prompts up to 100k tokens: $0.10 / $0.50 per million tokens.
    expect(callBoundUsd(MODEL, 50_000)).toBeCloseTo(50_000 * 0.1e-6 + 16_000 * 0.5e-6, 12);
  });

  it("uses the long-prompt price for both sides once the input bound passes 100k tokens", () => {
    expect(callBoundUsd(MODEL, 100_000)).toBeCloseTo(100_000 * 0.1e-6 + 16_000 * 0.5e-6, 12);
    expect(callBoundUsd(MODEL, 100_001)).toBeCloseTo(100_001 * 0.5e-6 + 16_000 * 2.5e-6, 12);
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

  it("settles a submission at the bound of the calls the server reported, the full bound when it reported none", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    const one = await ledger.reserve(bound(0.4), meta);
    await ledger.settle(one, { modelCalls: 1, serverProvider: `anthropic (${MODEL})` });
    expectCharged(ledger.spentUsd(), 0.1);
    const two = await ledger.reserve(bound(0.4), meta);
    await ledger.settle(two, { modelCalls: 2, serverProvider: `anthropic (${MODEL})` });
    expectCharged(ledger.spentUsd(), 0.5);
    const unknown = await ledger.reserve(bound(0.4), meta);
    await ledger.settle(unknown, { modelCalls: null, serverProvider: null });
    expectCharged(ledger.spentUsd(), 0.9);
    const none = await ledger.reserve(bound(0.4), meta);
    await ledger.settle(none, { modelCalls: 0, serverProvider: null });
    expectCharged(ledger.spentUsd(), 0.9);
    const reopened = await openLedger(file, 5);
    expectCharged(reopened.spentUsd(), 0.9);
  });

  it("charges more than the bound, never less, for a call count it did not expect", async () => {
    const ledger = await openLedger(file, 5, { create: true });
    const odd = await ledger.reserve(bound(0.4), meta);
    await ledger.settle(odd, { modelCalls: 3, serverProvider: null });
    expect(ledger.spentUsd()).toBeGreaterThanOrEqual(0.4);
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

  it("name the model, the ledger and the budget explicitly", () => {
    expect(liveSettings(env)).toEqual({ provider: "anthropic", model: MODEL, ledgerFile: "/tmp/ledger.json", budgetUsd: 5, createLedger: false });
    expect(liveSettings({ ...env, ASM_LIVE_LEDGER_CREATE: "1" }).createLedger).toBe(true);
  });

  it("refuse a run without a model of its own: neither the code's default nor .env.local decides what is paid for", () => {
    expect(() => liveSettings({ ...env, ASM_AGENT_MODEL: "" })).toThrow(BudgetRefusal);
    expect(() => liveSettings({ ...env, ASM_AGENT_MODEL: undefined })).toThrow(BudgetRefusal);
  });

  it("refuse a run without a ledger or without a positive budget", () => {
    expect(() => liveSettings({ ...env, ASM_LIVE_LEDGER: undefined })).toThrow(BudgetRefusal);
    for (const budget of [undefined, "", "0", "-1", "five"]) expect(() => liveSettings({ ...env, ASM_LIVE_BUDGET_USD: budget })).toThrow(BudgetRefusal);
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
