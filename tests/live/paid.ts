import { execFileSync } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { BudgetRefusal, boundForContext, expectServerModel, liveSettings, openLedger, stopFileOf, type SourceText } from "./budget";
import { assertNoSecretInRecord } from "./key-shapes";

const ROOT = path.join(__dirname, "..", "..");
const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: ROOT, encoding: "utf8" }).trim();

export type PaidAnswer = { status: number; body: Record<string, unknown> };
export type PaidRecord = { serverProvider: string | null; modelCalls: number | null; boundUsd: number; chargedUsd: number; ledgerSpentUsd: number };

/** What this process knows beyond the ledger: once a run has seen the wrong model, it sends nothing more, whatever the ledger says. */
export type PaidState = { stopped: string | null };
const PROCESS_STATE: PaidState = { stopped: null };

/**
 * One paid submission under the budget guard (ASM-34, AC-6): reserve the most
 * it can cost before anything is sent, send, settle what the server reported,
 * and stop when the server used another model than the run named. A send that
 * throws leaves the whole bound reserved. `options` are for tests: their own
 * process state, a hook on every ledger write, a shorter wait for the lock.
 */
export async function paidSubmission(
  label: string,
  name: string,
  sources: readonly SourceText[],
  send: () => Promise<PaidAnswer>,
  options: { state?: PaidState; onWrite?: (file: string) => void | Promise<void>; lockWaitMs?: number } = {},
): Promise<PaidAnswer & PaidRecord> {
  const state = options.state ?? PROCESS_STATE;
  if (state.stopped) throw new BudgetRefusal(`this run is stopped (${state.stopped}); nothing more is sent`);
  const settings = liveSettings();
  const ledgerFile = path.resolve(ROOT, settings.ledgerFile);
  const ledger = await openLedger(ledgerFile, settings.budgetUsd, {
    create: settings.createLedger,
    onWrite: options.onWrite,
    lockWaitMs: options.lockWaitMs,
  });
  const bound = boundForContext(settings.model, name, sources);
  const id = await ledger.reserve(bound, { label, commit: git("rev-parse", "HEAD"), model: settings.model });
  const answer = await send();
  const modelCalls = typeof answer.body.modelCalls === "number" ? answer.body.modelCalls : null;
  const reported = typeof answer.body.provider === "string" ? answer.body.provider : null;
  // The server's own words go into the ledger and the stop message only after the key check (verifier round 4).
  const serverProvider = reported !== null && !passesKeyCheck(reported) ? "[withheld: key-shaped text]" : reported;
  let mismatch: Error | null = null;
  try {
    expectServerModel(settings.provider, settings.model, serverProvider, modelCalls);
  } catch (error) {
    mismatch = error as Error;
  }
  // The charge stays the whole reservation. When the server did not answer as the model the run named (another model,
  // or none named after a call), the ledger is stopped in the same write: no further submission is sent, in this run
  // or the next, until a human looks (review round 2 on e4fb12a).
  if (mismatch) {
    // Stopped in this process and in a stop file beside the ledger first (written without the lock, so a ledger
    // another run holds stops nothing less, and a restarted worker reads it too), then in the ledger itself.
    state.stopped = mismatch.message;
    await fs.writeFile(stopFileOf(ledgerFile), `${new Date().toISOString()} ${label}: ${mismatch.message}\n`);
    try {
      await ledger.settle(id, { modelCalls, serverProvider, stop: mismatch.message });
    } catch (error) {
      throw new Error(`${mismatch.message}; the stop could not be written to the ledger (${(error as Error).message}); this run sends nothing more, and the ledger has to be stopped by hand`);
    }
    throw mismatch;
  }
  await ledger.settle(id, { modelCalls, serverProvider });
  const entry = ledger.entries()[id];
  return { ...answer, serverProvider, modelCalls, boundUsd: entry.boundMicroUsd.total / 1e6, chargedUsd: entry.chargedMicroUsd / 1e6, ledgerSpentUsd: ledger.spentUsd() };
}

function passesKeyCheck(text: string) {
  try {
    assertNoSecretInRecord(text);
    return true;
  } catch {
    return false;
  }
}

/** The ledger's state for a record: where it is, its budget, what it holds now. */
export async function ledgerSummary() {
  const settings = liveSettings();
  const ledger = await openLedger(path.resolve(ROOT, settings.ledgerFile), settings.budgetUsd);
  return { file: path.basename(settings.ledgerFile), budgetUsd: settings.budgetUsd, spentUsd: ledger.spentUsd(), entries: ledger.entries().length };
}
