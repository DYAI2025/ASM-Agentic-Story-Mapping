import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import YAML from "yaml";
import { LIVE_PRODUCT_FILE } from "../../playwright.live.config";
import { assertNoSecretInRecord } from "./key-shapes";
import { ledgerSummary, paidSubmission } from "./paid";

/**
 * ASM-28, real-provider intake with a human in the loop: realistic product
 * material (the External-QA kickoff transcript A3, no markers), the configured
 * real model, and a review in which the human chooses, rejects and edits before
 * accepting. Run by hand: `npm run intake:live`.
 *
 * What it proves: the real model's proposal reaches the review through the
 * same validation as every other; the review lets the human choose a reading
 * of the goal, reject an item and edit one; nothing is written before Accept;
 * the revision holds what the human kept. What it does not judge: whether the
 * proposal is semantically good. The record and the screenshots are material
 * for the human verdict (Gate E), not a verdict.
 *
 * The human's decisions follow a fixed rule so a rerun does the same thing:
 * the first reading of the goal where there is a choice, the last proposed
 * step rejected when there are at least two, the first need edited when there
 * is one. Whatever the proposal did not offer is named in the record
 * (`human.notPossible`) instead of passing silently.
 */
const ARTIFACTS = path.join(__dirname, "..", "..", ".e2e-artifacts", "live", "intake");
const FIXTURE = path.join(__dirname, "fixtures", "qa", "A3-meeting-transcript.txt");
const WORK_STATE_FILE = LIVE_PRODUCT_FILE.replace(/\.product\.yaml$/, ".work-state.json");
const NAME = "RotaCare";
const EDIT = " (confirmed in review)";
const shot = (name: string) => path.join(ARTIFACTS, `intake-${name}.png`);
const exists = (file: string) => fs.access(file).then(() => true, () => false);
const GROUPS = ["goal", "personas", "actors", "needs", "path", "questions"] as const;

type Operation = { op: string; opId?: string; [field: string]: unknown };

/** One line per proposed item, as the review groups it: what it says and where it says it came from. */
function describeOperation(operation: Operation) {
  const source = operation.source as { sourceId?: string; snippet?: string } | undefined;
  const text = ["statement", "name", "title", "question", "text"].map((field) => operation[field]).find((value) => typeof value === "string");
  return { opId: operation.opId ?? null, op: operation.op, text: (text as string | undefined) ?? null, sourceId: source?.sourceId ?? null, snippet: source?.snippet ?? null };
}

test("@intake realistic meeting transcript -> real provider -> human review with corrections -> accepted map", async ({ page }) => {
  test.setTimeout(900_000);
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await fs.rm(LIVE_PRODUCT_FILE, { force: true });
  await fs.rm(WORK_STATE_FILE, { force: true });
  const transcript = await fs.readFile(FIXTURE, "utf8");

  await page.goto("/");
  await expect(page.getByTestId("start-screen")).toBeVisible();
  await page.getByTestId("product-name-input").fill(NAME);
  await page.getByTestId("transcript-input").fill(transcript);
  await page.screenshot({ path: shot("01-input"), fullPage: true });

  const paid = await paidSubmission("intake A3", NAME, [{ label: "Pasted text", text: transcript }], async () => {
    const answer = page.waitForResponse((r) => r.url().endsWith("/api/bootstrap") && r.request().method() === "POST", { timeout: 540_000 });
    await page.getByTestId("structure-button").click();
    const response = await answer;
    return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
  });
  const operations = ((paid.body.patch as { operations?: Operation[] } | undefined)?.operations ?? []).map(describeOperation);
  const base = {
    ranAt: new Date().toISOString(),
    commit: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" }).trim(),
    input: { fixture: path.basename(FIXTURE), sha256: createHash("sha256").update(transcript).digest("hex"), words: transcript.split(/\s+/).filter(Boolean).length },
    serverProvider: paid.serverProvider,
    httpStatus: paid.status,
    modelCalls: paid.modelCalls,
    chargedUsd: paid.chargedUsd,
    budget: await ledgerSummary(),
  };
  const write = async (record: object) => {
    const text = JSON.stringify(record, null, 2);
    assertNoSecretInRecord(text);
    await fs.writeFile(path.join(ARTIFACTS, "record.json"), text);
  };

  if (paid.status !== 200) {
    await page.screenshot({ path: shot("02-refused"), fullPage: true });
    const issues = (paid.body.issues as { code: string; path: string; message: string }[] | undefined) ?? [];
    await write({ ...base, outcome: "refused", issues: issues.slice(0, 10), productFileAfter: await exists(LIVE_PRODUCT_FILE) });
    expect(await exists(LIVE_PRODUCT_FILE)).toBe(false);
    expect(paid.status, "the real provider's proposal did not reach review").toBe(200);
  }

  // The review, as the human first sees it.
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  const sections: Record<string, number> = {};
  for (const group of GROUPS) sections[group] = await page.getByTestId(`proposal-section-${group}`).locator("[data-testid^='diff-op-']").count();
  await page.screenshot({ path: shot("02-review"), fullPage: true });

  const human: Record<string, unknown> = { notPossible: [] as string[] };
  const notPossible = human.notPossible as string[];
  // 1. A reading of the goal, where there is a choice.
  const choice = page.getByTestId("goal-choice");
  if (!(await choice.count())) notPossible.push("choose a goal reading: the proposal offers one goal only");
  if (await choice.count()) {
    const reading = choice.locator("[data-testid^='diff-op-']").first();
    const opId = (await reading.getAttribute("data-testid"))!.replace(/^diff-/, "");
    await reading.getByRole("radio").check();
    human.goalChoice = { readings: await choice.getByRole("radio").count(), chosen: operations.find((o) => o.opId === opId) ?? { opId } };
  }
  // 2. Reject the last proposed step, when there are at least two.
  const steps = page.getByTestId("proposal-section-path").locator("[data-testid^='diff-op-']");
  if ((await steps.count()) >= 2) {
    const last = steps.last();
    const opId = (await last.getAttribute("data-testid"))!.replace(/^diff-/, "");
    await page.getByLabel(`Include ${opId}`, { exact: true }).uncheck();
    await expect(last).toHaveAttribute("data-state", "rejected");
    human.rejected = operations.find((o) => o.opId === opId) ?? { opId };
  } else notPossible.push("reject a step: the proposal has fewer than two path items");
  // 3. Edit the first need.
  const needs = page.getByTestId("proposal-section-needs").locator("[data-testid^='diff-op-']");
  if (await needs.count()) {
    const first = needs.first();
    const opId = (await first.getAttribute("data-testid"))!.replace(/^diff-/, "");
    await page.getByTestId(`edit-${opId}`).click();
    const field = page.locator(`textarea[name='${opId}-statement']`);
    const before = await field.inputValue();
    await field.fill(`${before}${EDIT}`);
    await page.getByTestId(`edit-${opId}`).click();
    await expect(first).toContainText(EDIT.trim());
    human.edited = { opId, before, after: `${before}${EDIT}` };
  } else notPossible.push("edit a need: the proposal has no need");
  // Nothing is written while the human reviews.
  expect(await exists(LIVE_PRODUCT_FILE)).toBe(false);
  expect(await exists(WORK_STATE_FILE)).toBe(false);
  await page.screenshot({ path: shot("03-corrected"), fullPage: true });

  // Accept: the first revision, holding what the human kept.
  await expect(page.getByTestId("proposal-accept")).toBeEnabled();
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await page.screenshot({ path: shot("04-accepted-map"), fullPage: true });

  const stored = YAML.parse(await fs.readFile(LIVE_PRODUCT_FILE, "utf8"));
  expect(stored.revision).toEqual({ number: 1, status: "proposed" });
  if (human.edited) expect(stored.needs.map((n: { statement: string }) => n.statement)).toContain((human.edited as { after: string }).after);
  // The rejected step is not on the map, unless another kept step has the same title.
  const rejected = human.rejected as { op?: string; text?: string | null; opId?: string } | undefined;
  if (rejected?.op === "add_step" && rejected.text && operations.filter((o) => o.op === "add_step" && o.text === rejected.text).length === 1)
    expect(stored.narrative.map((step: { title: string }) => step.title)).not.toContain(rejected.text);
  if (human.goalChoice) expect(stored.goal.statement).toBe(((human.goalChoice as { chosen: { text?: string } }).chosen.text));
  // Every quote the map keeps occurs in the transcript, runs of whitespace counted as one space.
  const flat = transcript.replace(/\s+/g, " ");
  for (const entry of stored.provenance) expect(flat).toContain(String(entry.snippet).replace(/\s+/g, " ").trim());

  const people = stored.personas as { id: string; name: string; persona?: boolean; roles?: string[] }[];
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? id;
  await write({
    ...base,
    outcome: "accepted",
    proposal: { sections, operations },
    human,
    accepted: {
      revision: stored.revision,
      goal: stored.goal.statement,
      personas: people.filter((p) => p.persona !== false).map((p) => ({ name: p.name, roles: p.roles ?? [] })),
      otherActors: people.filter((p) => p.persona === false).map((p) => ({ name: p.name, roles: p.roles ?? [] })),
      needs: (stored.needs as { personaId: string; statement: string }[]).map((n) => ({ persona: nameOf(n.personaId), statement: n.statement })),
      steps: (stored.narrative as { sequence: number; title: string; personaIds: string[] }[]).map((s) => ({ sequence: s.sequence, title: s.title, personas: s.personaIds.map(nameOf) })),
      openQuestions: (stored.decisions as { title: string; status: string }[]).filter((d) => d.status === "open").map((d) => d.title),
      provenanceEntries: stored.provenance.length,
    },
  });
  await fs.copyFile(LIVE_PRODUCT_FILE, path.join(ARTIFACTS, "accepted.product.yaml"));
});
