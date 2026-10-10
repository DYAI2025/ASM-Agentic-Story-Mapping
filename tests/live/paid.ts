import { execFileSync } from "node:child_process";
import path from "node:path";
import { boundForContext, expectServerModel, liveSettings, openLedger, type SourceText } from "./budget";

const ROOT = path.join(__dirname, "..", "..");
const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: ROOT, encoding: "utf8" }).trim();

export type PaidAnswer = { status: number; body: Record<string, unknown> };
export type PaidRecord = { serverProvider: string | null; modelCalls: number | null; boundUsd: number; chargedUsd: number; ledgerSpentUsd: number };

/**
 * One paid submission under the budget guard (ASM-34, AC-6): reserve the most
 * it can cost before anything is sent, send, settle what the server reported,
 * and stop when the server used another model than the run named. A send that
 * throws leaves the whole bound reserved.
 */
export async function paidSubmission(label: string, name: string, sources: readonly SourceText[], send: () => Promise<PaidAnswer>): Promise<PaidAnswer & PaidRecord> {
  const settings = liveSettings();
  const ledger = await openLedger(path.resolve(ROOT, settings.ledgerFile), settings.budgetUsd, { create: settings.createLedger });
  const bound = boundForContext(settings.model, name, sources);
  const id = await ledger.reserve(bound, { label, commit: git("rev-parse", "HEAD"), model: settings.model });
  const answer = await send();
  const modelCalls = typeof answer.body.modelCalls === "number" ? answer.body.modelCalls : null;
  const serverProvider = typeof answer.body.provider === "string" ? answer.body.provider : null;
  await ledger.settle(id, { modelCalls, serverProvider });
  expectServerModel(settings.provider, settings.model, serverProvider, modelCalls);
  const entry = ledger.entries()[id];
  return { ...answer, serverProvider, modelCalls, boundUsd: entry.boundMicroUsd.total / 1e6, chargedUsd: entry.chargedMicroUsd / 1e6, ledgerSpentUsd: ledger.spentUsd() };
}

/** The ledger's state for a record: where it is, its budget, what it holds now. */
export async function ledgerSummary() {
  const settings = liveSettings();
  const ledger = await openLedger(path.resolve(ROOT, settings.ledgerFile), settings.budgetUsd);
  return { file: path.basename(settings.ledgerFile), budgetUsd: settings.budgetUsd, spentUsd: ledger.spentUsd(), entries: ledger.entries().length };
}
