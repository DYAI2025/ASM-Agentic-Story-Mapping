import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetRefusal, boundForContext, openLedger } from "../live/budget";
import { paidSubmission, type PaidAnswer } from "../live/paid";

/**
 * ASM-34, AC-6: the order a paid submission keeps (`tests/live/paid.ts`),
 * with a ledger in a scratch directory and a stand-in for the browser's
 * request: the bound is reserved before anything is sent, a submission the
 * budget cannot take is never sent, what the server reported is charged, a
 * send that fails keeps the whole bound, and an answer from another model
 * stops the run after it was charged.
 */
const MODEL = "claude-haiku-5-5";
const NAME = "RotaCare";
const SOURCES = [{ label: "Pasted text", text: "Kick-off. Residents miss parcels; Maya wants lockers in the lobby." }];
const bound = boundForContext(MODEL, NAME, SOURCES);
const answer = (body: Record<string, unknown>, status = 200): PaidAnswer => ({ status, body });

describe("a paid submission", () => {
  let dir: string;
  let ledgerFile: string;
  const saved = { ...process.env };
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "asm-paid-")));
    ledgerFile = path.join(dir, "ledger.json");
    Object.assign(process.env, {
      ASM_AGENT_PROVIDER: "anthropic",
      ASM_AGENT_MODEL: MODEL,
      ASM_LIVE_LEDGER: ledgerFile,
      ASM_LIVE_BUDGET_USD: "5",
      ASM_LIVE_LEDGER_CREATE: "1",
    });
  });
  afterEach(async () => {
    for (const key of ["ASM_AGENT_PROVIDER", "ASM_AGENT_MODEL", "ASM_LIVE_LEDGER", "ASM_LIVE_BUDGET_USD", "ASM_LIVE_LEDGER_CREATE"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is written down in full before it is sent", async () => {
    let seenWhileSending = -1;
    await paidSubmission("t", NAME, SOURCES, async () => {
      seenWhileSending = (await openLedger(ledgerFile, 5)).spentUsd();
      return answer({ modelCalls: 1, provider: `anthropic (${MODEL})` });
    });
    expect(seenWhileSending).toBeGreaterThanOrEqual(bound.totalUsd);
  });

  it("is charged its whole bound, whatever the server reported, and records what the server named", async () => {
    const paid = await paidSubmission("t", NAME, SOURCES, async () => answer({ modelCalls: 1, provider: `anthropic (${MODEL})` }));
    expect(paid.serverProvider).toBe(`anthropic (${MODEL})`);
    expect(paid.modelCalls).toBe(1);
    expect(paid.chargedUsd).toBeGreaterThanOrEqual(bound.totalUsd);
    const entry = (await openLedger(ledgerFile, 5)).entries()[0];
    expect(entry).toMatchObject({ status: "settled", modelCalls: 1, serverProvider: `anthropic (${MODEL})`, model: MODEL, label: "t" });
    expect(entry.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is not sent when the budget cannot take its bound", async () => {
    process.env.ASM_LIVE_BUDGET_USD = String(bound.totalUsd / 2);
    let sent = false;
    await expect(
      paidSubmission("t", NAME, SOURCES, async () => {
        sent = true;
        return answer({ modelCalls: 1, provider: `anthropic (${MODEL})` });
      }),
    ).rejects.toThrow(BudgetRefusal);
    expect(sent).toBe(false);
  });

  it("is not sent without a ledger when creating one was not asked for", async () => {
    delete process.env.ASM_LIVE_LEDGER_CREATE;
    let sent = false;
    await expect(
      paidSubmission("t", NAME, SOURCES, async () => {
        sent = true;
        return answer({});
      }),
    ).rejects.toThrow(BudgetRefusal);
    expect(sent).toBe(false);
  });

  it("keeps the whole bound when the send fails before an answer", async () => {
    await expect(paidSubmission("t", NAME, SOURCES, async () => Promise.reject(new Error("browser gave up")))).rejects.toThrow("browser gave up");
    const ledger = await openLedger(ledgerFile, 5);
    expect(ledger.entries()[0].status).toBe("reserved");
    expect(ledger.spentUsd()).toBeGreaterThanOrEqual(bound.totalUsd);
  });

  it("stops the run when the server answered as another model, after charging it the whole bound", async () => {
    await expect(paidSubmission("t", NAME, SOURCES, async () => answer({ modelCalls: 1, provider: "anthropic (claude-opus-5-5)" }))).rejects.toThrow(/claude-opus-5-5/);
    const ledger = await openLedger(ledgerFile, 5);
    expect(ledger.entries()[0]).toMatchObject({ status: "settled", modelCalls: 1, serverProvider: "anthropic (claude-opus-5-5)" });
    // One call reported, but by a model the guard has no price for: the whole bound, the most it knows how to count.
    expect(ledger.spentUsd()).toBeGreaterThanOrEqual(bound.totalUsd);
  });

  it("stops the run and the ledger when the server made a call and named no model", async () => {
    await expect(paidSubmission("t", NAME, SOURCES, async () => answer({ modelCalls: 1 }, 502))).rejects.toThrow();
    const onDisk = JSON.parse(await fs.readFile(ledgerFile, "utf8"));
    expect(onDisk.stoppedReason).toMatch(/null/);
    let sent = false;
    await expect(
      paidSubmission("t2", NAME, SOURCES, async () => {
        sent = true;
        return answer({ modelCalls: 1, provider: `anthropic (${MODEL})` });
      }),
    ).rejects.toThrow(/stopped/);
    expect(sent).toBe(false);
  });

  it("settles and stops in one write: the stop is on disk together with the mismatched entry", async () => {
    await expect(paidSubmission("t", NAME, SOURCES, async () => answer({ modelCalls: 2, provider: "anthropic (claude-opus-5-5)" }))).rejects.toThrow();
    const onDisk = JSON.parse(await fs.readFile(ledgerFile, "utf8"));
    expect(onDisk.entries[0]).toMatchObject({ status: "settled", modelCalls: 2, serverProvider: "anthropic (claude-opus-5-5)" });
    expect(onDisk.stoppedReason).toMatch(/claude-opus-5-5/);
  });

  it("charges the whole bound for an answer that does not say how many calls it made", async () => {
    await expect(paidSubmission("t", NAME, SOURCES, async () => answer({}, 502))).rejects.toThrow();
    const ledger = await openLedger(ledgerFile, 5);
    expect(ledger.entries()[0]).toMatchObject({ status: "settled", modelCalls: null });
    expect(ledger.spentUsd()).toBeGreaterThanOrEqual(bound.totalUsd);
  });

  it("stops the ledger when the server answered as another model: the next submission is not sent", async () => {
    await expect(paidSubmission("t", NAME, SOURCES, async () => answer({ modelCalls: 1, provider: "anthropic (claude-opus-5-5)" }))).rejects.toThrow();
    let sent = false;
    await expect(
      paidSubmission("t2", NAME, SOURCES, async () => {
        sent = true;
        return answer({ modelCalls: 1, provider: `anthropic (${MODEL})` });
      }),
    ).rejects.toThrow(/stopped/);
    expect(sent).toBe(false);
  });

  it("keeps the whole bound even for an answer that made no call: the charge never goes down", async () => {
    const paid = await paidSubmission("t", NAME, SOURCES, async () => answer({ modelCalls: 0 }, 409));
    expect(paid.chargedUsd).toBeGreaterThanOrEqual(bound.totalUsd);
  });
});
