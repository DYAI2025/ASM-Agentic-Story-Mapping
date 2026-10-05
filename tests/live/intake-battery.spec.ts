import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import YAML from "yaml";
import { LIVE_PRODUCT_FILE } from "../../playwright.live.config";

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

type Outcome = {
  id: string;
  valid: boolean;
  httpStatus: number;
  modelCalls: number | null;
  seconds: number;
  operations: Record<string, number>;
  issueCodes: Record<string, number>;
  issueCount: number;
  /** The first few messages as the human saw them (provider messages are redacted at the adapter boundary). */
  firstMessages: string[];
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
  await fs.writeFile(path.join(ARTIFACTS, `${outcome.id}.json`), JSON.stringify({ runId: RUN_ID, ...outcome }, null, 2));
  const outcomes = await readOutcomes();
  const record = {
    runId: RUN_ID,
    ranAt: new Date().toISOString(),
    commit: git("rev-parse", "HEAD"),
    // Uncommitted changes under src/ would make the commit the wrong name for what ran.
    srcChangesSinceCommit: git("status", "--porcelain", "--", "src"),
    provider: process.env.ASM_AGENT_PROVIDER,
    model: process.env.ASM_AGENT_MODEL ?? null,
    threshold: "at least 4 of 5 valid; every failure writes nothing",
    valid: outcomes.filter((o) => o.valid).length,
    submitted: outcomes.length,
    outcomes,
  };
  const text = JSON.stringify(record, null, 2);
  expect(text).not.toMatch(/(sk|or)-[A-Za-z0-9_-]{8,}/);
  await fs.writeFile(path.join(ARTIFACTS, "battery.json"), text);
}

async function submit(page: Page, submission: Submission) {
  await page.goto("/");
  await expect(page.getByTestId("start-screen")).toBeVisible();
  await page.getByTestId("product-name-input").fill(NAME);
  await page.getByTestId("transcript-input").fill(await fs.readFile(path.join(FIXTURES, submission.pasted), "utf8"));
  if (submission.files) await page.getByTestId("context-files").setInputFiles(submission.files.map((f) => path.join(FIXTURES, f)));
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/bootstrap") && r.request().method() === "POST", { timeout: 540_000 });
  const started = Date.now();
  await page.getByTestId("structure-button").click();
  const response = await answer;
  const seconds = Math.round((Date.now() - started) / 1000);
  const body = (await response.json()) as { patch?: { operations: { op: string }[] }; issues?: { code: string; path: string; message: string }[]; modelCalls?: number };
  return { response, body, seconds };
}

for (const submission of BATTERY) {
  test(`@battery ${submission.id}: proposal for human review, or a refusal that writes nothing`, async ({ page }) => {
    test.setTimeout(600_000);
    if (submission !== BATTERY[0]) await page.waitForTimeout(PAUSE_MS);
    await fs.rm(LIVE_PRODUCT_FILE, { force: true });
    await fs.rm(WORK_STATE_FILE, { force: true });
    const fixtureSha256: Record<string, string> = {};
    for (const f of [submission.pasted, ...(submission.files ?? [])]) fixtureSha256[f] = await sha256(path.join(FIXTURES, f));

    const { response, body, seconds } = await submit(page, submission);
    const valid = response.status() === 200 && Array.isArray(body.patch?.operations);
    if (valid) {
      // A proposal is shown for review and nothing is canon yet.
      await expect(page.getByTestId("proposal-review")).toBeVisible();
      await expect(page.getByTestId("proposal-issues")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("proposal-issues")).toBeVisible();
      await expect(page.getByTestId("proposal-review")).toHaveCount(0);
    }
    await page.screenshot({ path: path.join(ARTIFACTS, `${submission.id}.png`), fullPage: true });

    const outcome: Outcome = {
      id: submission.id,
      valid,
      httpStatus: response.status(),
      modelCalls: typeof body.modelCalls === "number" ? body.modelCalls : null,
      seconds,
      operations: tally((body.patch?.operations ?? []).map((o) => o.op)),
      issueCodes: tally((body.issues ?? []).map((i) => i.code)),
      issueCount: (body.issues ?? []).length,
      firstMessages: (body.issues ?? []).slice(0, 3).map((i) => `${i.code} ${i.path}: ${i.message}`.slice(0, 300)),
      productFileAfter: await exists(LIVE_PRODUCT_FILE),
      workStateFileAfter: await exists(WORK_STATE_FILE),
      fixtureSha256,
    };
    await writeRecord(outcome);
    // Whatever the model did, building a proposal writes nothing.
    expect(outcome.productFileAfter).toBe(false);
    expect(outcome.workStateFileAfter).toBe(false);
    if (outcome.modelCalls !== null) expect(outcome.modelCalls).toBeLessThanOrEqual(2);
  });
}

test("@battery the first valid proposal becomes canon only through Human Accept", async ({ page }) => {
  test.setTimeout(600_000);
  const first = (await readOutcomes()).find((o) => o.valid);
  test.skip(!first, "no valid proposal in this run to accept");
  await page.waitForTimeout(PAUSE_MS);
  const submission = BATTERY.find((s) => s.id === first!.id)!;
  await fs.rm(LIVE_PRODUCT_FILE, { force: true });
  await fs.rm(WORK_STATE_FILE, { force: true });
  const { response } = await submit(page, submission);
  test.skip(response.status() !== 200, "the second submission of the same text was refused this time; recorded above, nothing to accept");
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  expect(await exists(LIVE_PRODUCT_FILE)).toBe(false);
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await page.screenshot({ path: path.join(ARTIFACTS, `${submission.id}-accepted.png`), fullPage: true });
  const stored = YAML.parse(await fs.readFile(LIVE_PRODUCT_FILE, "utf8"));
  expect(stored.revision).toEqual({ number: 1, status: "proposed" });
  // Every recorded quote occurs in the source it names.
  const texts: Record<string, string> = {};
  for (const f of [submission.pasted, ...(submission.files ?? [])]) texts[f] = (await fs.readFile(path.join(FIXTURES, f), "utf8")).replace(/\s+/g, " ");
  for (const entry of stored.provenance) {
    const label = entry.sourceLabel === "Pasted text" ? submission.pasted : entry.sourceLabel;
    expect(texts[label]).toContain(String(entry.snippet).replace(/\s+/g, " ").trim());
  }
  await fs.copyFile(LIVE_PRODUCT_FILE, path.join(ARTIFACTS, `${submission.id}-accepted.product.yaml`));
});

test("@battery threshold: at least 4 of 5 valid", async () => {
  const outcomes = await readOutcomes();
  expect(outcomes).toHaveLength(BATTERY.length);
  expect(outcomes.filter((o) => o.valid).length).toBeGreaterThanOrEqual(4);
});
