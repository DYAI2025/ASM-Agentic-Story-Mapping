import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import YAML from "yaml";
import { LIVE_PRODUCT_FILE } from "../../playwright.live.config";
import { liveSettings } from "./budget";
import { assertNoSecretInRecord } from "./key-shapes";
import { ledgerSummary, paidSubmission } from "./paid";

/**
 * ASM-29, AC-29-01: the External-QA intake battery (A2, A3, A4-mid, A4-large,
 * A5) through the configured real provider, in the browser, from the start
 * screen of a fresh workspace each time. Nothing here decides whether a
 * proposal is good; it records what the product did with each submission:
 * a proposal the human can review, or a visible refusal that wrote nothing.
 *
 * The fixtures are the External-QA files of 2026-10-04 (`fixtures/qa`, see
 * `SHA256SUMS`). Run by hand: `npm run battery:live`. The record goes to
 * `.e2e-artifacts/live/battery.json` and names the commit it ran on.
 *
 * ASM-34: every submission goes through the budget guard (`./paid`), and each
 * attempt records the provider and model the server said it used and what the
 * ledger charged for it.
 */
const ARTIFACTS = path.join(__dirname, "..", "..", ".e2e-artifacts", "live", "battery");
const FIXTURES = path.join(__dirname, "fixtures", "qa");
const WORK_STATE_FILE = LIVE_PRODUCT_FILE.replace(/\.product\.yaml$/, ".work-state.json");
const NAME = "RotaCare";
/**
 * Time between two submissions. On 2026-10-05 the reference model answered a submission sent one second
 * after the previous one with OpenRouter's 429; a person would not paste the next document that fast either.
 */
const PAUSE_MS = Number(process.env.BATTERY_PAUSE_MS ?? 60_000);
/** One id per run, set by `npm run battery:live`; a record from an earlier run is never counted. */
const RUN_ID = process.env.BATTERY_RUN_ID;
test.skip(!RUN_ID, "run the battery with npm run battery:live (BATTERY_RUN_ID is not set)");

type Submission = { id: string; pasted: string; files?: string[] };
const BATTERY: Submission[] = [
  { id: "A2", pasted: "A2-product-description.txt" },
  { id: "A3", pasted: "A3-meeting-transcript.txt" },
  { id: "A4-mid", pasted: "A4-mid-5k.txt" },
  { id: "A4-large", pasted: "A4-large-near-limit.txt" },
  { id: "A5", pasted: "A5-pasted.txt", files: ["A5-matrix.txt", "A5-notes.md"] },
];

type Attempt = {
  httpStatus: number;
  modelCalls: number | null;
  seconds: number;
  operations: Record<string, number>;
  issueCodes: Record<string, number>;
  issueCount: number;
  /** The first few messages as the human saw them (provider messages are redacted at the adapter boundary). */
  firstMessages: string[];
  /** The provider and model the server named in its answer (`provider`), not the one the shell asked for. */
  serverProvider: string | null;
  /** What the budget ledger charged for this attempt: the bound of the model calls the server reported. */
  chargedUsd: number;
};

type Outcome = Attempt & {
  id: string;
  /** Whether the submission ended in a proposal for human review (after a resubmission following a 429, if one happened). */
  valid: boolean;
  /** The same, counting the first attempt only. */
  validFirstAttempt: boolean;
  /** Every attempt: one, or more when the provider answered 429 and the submission was made again after its retry-after (at most three times). */
  attempts: Attempt[];
  productFileAfter: boolean;
  workStateFileAfter: boolean;
  fixtureSha256: Record<string, string>;
};

const exists = (file: string) => fs.access(file).then(() => true, () => false);
const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" }).trim();
const tally = (values: string[]) => values.reduce<Record<string, number>>((sum, v) => ({ ...sum, [v]: (sum[v] ?? 0) + 1 }), {});
const sha256 = async (file: string) => createHash("sha256").update(await fs.readFile(file)).digest("hex");

/** Each submission writes its own file, so a failed test (and the worker restart after it) loses nothing. */
async function readOutcomes(): Promise<Outcome[]> {
  const found: Outcome[] = [];
  for (const submission of BATTERY) {
    const text = await fs.readFile(path.join(ARTIFACTS, `${submission.id}.json`), "utf8").catch(() => null);
    if (!text) continue;
    const saved = JSON.parse(text) as Outcome & { runId: string };
    if (saved.runId === RUN_ID) found.push(saved);
  }
  return found;
}

async function writeRecord(outcome: Outcome) {
  await fs.mkdir(ARTIFACTS, { recursive: true });
  // Checked before it is written, like the summary below: nothing of a paid run reaches the disk unchecked.
  const caseText = JSON.stringify({ runId: RUN_ID, ...outcome }, null, 2);
  assertNoSecretInRecord(caseText);
  await fs.writeFile(path.join(ARTIFACTS, `${outcome.id}.json`), caseText);
  const outcomes = await readOutcomes();
  const record = {
    runId: RUN_ID,
    ranAt: new Date().toISOString(),
    commit: git("rev-parse", "HEAD"),
    // Uncommitted changes under src/ would make the commit the wrong name for what ran.
    srcChangesSinceCommit: git("status", "--porcelain", "--", "src"),
    provider: process.env.ASM_AGENT_PROVIDER,
    model: liveSettings().model,
    // What the server said it used, over every attempt of the run: one value, the model above, or the run stopped.
    serverProviders: [...new Set(outcomes.flatMap((o) => o.attempts.map((a) => a.serverProvider)))],
    budget: await ledgerSummary(),
    threshold: "at least 4 of 5 valid; every failure writes nothing",
    valid: outcomes.filter((o) => o.valid).length,
    validFirstAttempt: outcomes.filter((o) => o.validFirstAttempt).length,
    submitted: outcomes.length,
    accepted: await fs.readFile(ACCEPTED_MARKER, "utf8").then((text) => (JSON.parse(text).runId === RUN_ID ? JSON.parse(text) : null), () => null),
    outcomes,
  };
  const text = JSON.stringify(record, null, 2);
  assertNoSecretInRecord(text);
  await fs.writeFile(path.join(ARTIFACTS, "battery.json"), text);
}

async function submit(page: Page, submission: Submission): Promise<{ attempt: Attempt; valid: boolean }> {
  await page.goto("/");
  await expect(page.getByTestId("start-screen")).toBeVisible();
  await page.getByTestId("product-name-input").fill(NAME);
  await page.getByTestId("transcript-input").fill(await fs.readFile(path.join(FIXTURES, submission.pasted), "utf8"));
  if (submission.files) await page.getByTestId("context-files").setInputFiles(submission.files.map((f) => path.join(FIXTURES, f)));
  const sources = [
    { label: "Pasted text", text: await fs.readFile(path.join(FIXTURES, submission.pasted), "utf8") },
    ...(await Promise.all((submission.files ?? []).map(async (f) => ({ label: f, text: await fs.readFile(path.join(FIXTURES, f), "utf8") })))),
  ];
  const started = Date.now();
  const paid = await paidSubmission(`battery ${submission.id}`, NAME, sources, async () => {
    const answer = page.waitForResponse((r) => r.url().endsWith("/api/bootstrap") && r.request().method() === "POST", { timeout: 540_000 });
    await page.getByTestId("structure-button").click();
    const response = await answer;
    return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const body = paid.body as { patch?: { operations: { op: string }[] }; issues?: { code: string; path: string; message: string }[]; modelCalls?: number };
  const valid = paid.status === 200 && Array.isArray(body.patch?.operations);
  if (valid) {
    // A proposal is shown for review and nothing is canon yet. With more than one reading of the goal the
    // human has to pick one first (AC-FUF-05), and the review says so: that refusal is about the choice
    // still open, not about the proposal.
    await expect(page.getByTestId("proposal-review")).toBeVisible();
    const goalChoice = (body.patch?.operations ?? []).filter((o) => o.op === "set_goal").length > 1;
    if (goalChoice) await expect(page.getByTestId("goal-choice")).toBeVisible();
    else await expect(page.getByTestId("proposal-issues")).toHaveCount(0);
  } else {
    await expect(page.getByTestId("proposal-issues")).toBeVisible();
    await expect(page.getByTestId("proposal-review")).toHaveCount(0);
  }
  return {
    valid,
    attempt: {
      httpStatus: paid.status,
      modelCalls: typeof body.modelCalls === "number" ? body.modelCalls : null,
      seconds,
      operations: tally((body.patch?.operations ?? []).map((o) => o.op)),
      issueCodes: tally((body.issues ?? []).map((i) => i.code)),
      issueCount: (body.issues ?? []).length,
      firstMessages: (body.issues ?? []).slice(0, 3).map((i) => `${i.code} ${i.path}: ${i.message}`.slice(0, 300)),
      serverProvider: paid.serverProvider,
      chargedUsd: paid.chargedUsd,
    },
  };
}

/**
 * The product tells the human "rate limit reached; try again shortly" when the provider answers 429. Measured on
 * 2026-10-06: OpenRouter's upstream for the reference model (GMICloud, shared pool) answered 429 with
 * `retry_after_seconds: 60`. A person would try again after that, so the battery does too, up to three times
 * (PO decision 2026-10-06), and records every attempt; `validFirstAttempt` keeps the strict count.
 */
const RETRY_AFTER_MS = Number(process.env.BATTERY_RETRY_AFTER_MS ?? 75_000);
const MAX_RESUBMISSIONS = 3;
const rateLimited = (attempt: Attempt) => attempt.httpStatus === 502 && attempt.firstMessages.some((m) => /rate limit/i.test(m));
const ACCEPTED_MARKER = path.join(ARTIFACTS, "accepted.json");

for (const submission of BATTERY) {
  test(`@battery ${submission.id}: proposal for human review, or a refusal that writes nothing`, async ({ page }) => {
    test.setTimeout(1_500_000);
    if (submission !== BATTERY[0]) await page.waitForTimeout(PAUSE_MS);
    await fs.rm(LIVE_PRODUCT_FILE, { force: true });
    await fs.rm(WORK_STATE_FILE, { force: true });
    const fixtureSha256: Record<string, string> = {};
    for (const f of [submission.pasted, ...(submission.files ?? [])]) fixtureSha256[f] = await sha256(path.join(FIXTURES, f));

    const first = await submit(page, submission);
    const attempts = [first.attempt];
    let last = first;
    while (rateLimited(last.attempt) && attempts.length <= MAX_RESUBMISSIONS) {
      await page.waitForTimeout(RETRY_AFTER_MS);
      last = await submit(page, submission);
      attempts.push(last.attempt);
    }
    await page.screenshot({ path: path.join(ARTIFACTS, `${submission.id}.png`), fullPage: true });

    const productFileAfter = await exists(LIVE_PRODUCT_FILE);
    const workStateFileAfter = await exists(WORK_STATE_FILE);
    // A submission only counts when it also kept the other promises: nothing written, a reported call count of 1 or 2.
    const boundKept = (attempt: Attempt) => Number.isInteger(attempt.modelCalls) && attempt.modelCalls! >= 1 && attempt.modelCalls! <= 2;
    const nothingWritten = !productFileAfter && !workStateFileAfter;
    const outcome: Outcome = {
      id: submission.id,
      // Every attempt of the submission has to have kept the bound, not only the last one.
      valid: last.valid && nothingWritten && attempts.every(boundKept),
      validFirstAttempt: first.valid && nothingWritten && boundKept(first.attempt),
      ...last.attempt,
      attempts,
      productFileAfter,
      workStateFileAfter,
      fixtureSha256,
    };
    await writeRecord(outcome);
    // Whatever the model did, building a proposal writes nothing, and every answer reports its model calls.
    expect(outcome.productFileAfter).toBe(false);
    expect(outcome.workStateFileAfter).toBe(false);
    for (const attempt of attempts) expect(boundKept(attempt), JSON.stringify(attempt)).toBe(true);

    // The first valid proposal of the run is accepted as a human would, on the screen it was reviewed on.
    const accepted = await fs.readFile(ACCEPTED_MARKER, "utf8").then((text) => JSON.parse(text).runId === RUN_ID, () => false);
    if (!outcome.valid || accepted) return;
    // Where the human has to pick a reading of the goal, the battery picks the first, as a person would pick one.
    const choice = page.getByTestId("goal-choice");
    if (await choice.count()) await choice.getByRole("radio").first().check();
    await page.getByTestId("proposal-accept").click();
    await expect(page.getByTestId("revision-status")).toHaveText("proposed");
    await page.screenshot({ path: path.join(ARTIFACTS, `${submission.id}-accepted-${RUN_ID}.png`), fullPage: true });
    const stored = YAML.parse(await fs.readFile(LIVE_PRODUCT_FILE, "utf8"));
    expect(stored.revision).toEqual({ number: 1, status: "proposed" });
    // Every recorded quote occurs in the source it names, with runs of whitespace counted as one space: the
    // rule resolveProposal applies, accepted by the PO on 2026-10-06 as the meaning of an exact quote.
    const texts: Record<string, string> = {};
    for (const f of [submission.pasted, ...(submission.files ?? [])]) texts[f] = (await fs.readFile(path.join(FIXTURES, f), "utf8")).replace(/\s+/g, " ");
    for (const entry of stored.provenance) {
      const label = entry.sourceLabel === "Pasted text" ? submission.pasted : entry.sourceLabel;
      expect(texts[label]).toContain(String(entry.snippet).replace(/\s+/g, " ").trim());
    }
    await fs.copyFile(LIVE_PRODUCT_FILE, path.join(ARTIFACTS, `${submission.id}-accepted-${RUN_ID}.product.yaml`));
    await fs.writeFile(ACCEPTED_MARKER, JSON.stringify({ runId: RUN_ID, id: submission.id, revision: stored.revision, provenanceEntries: stored.provenance.length }));
    await fs.rm(LIVE_PRODUCT_FILE, { force: true });
  });
}

test("@battery threshold: at least 4 of 5 valid", async () => {
  const outcomes = await readOutcomes();
  expect(outcomes).toHaveLength(BATTERY.length);
  expect(outcomes.filter((o) => o.valid).length).toBeGreaterThanOrEqual(4);
});
