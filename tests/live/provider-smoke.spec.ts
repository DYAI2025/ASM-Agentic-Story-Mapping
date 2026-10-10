import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import YAML from "yaml";
import { BAD_KEY_PRODUCT_FILE, LIVE_PRODUCT_FILE } from "../../playwright.live.config";
import { ledgerSummary, paidSubmission } from "./paid";

/**
 * Live provider smoke (ASM-25, AC-7): ordinary meeting text, no markers, through
 * the configured real provider, to a proposal a human reviews and accepts as
 * proposed revision 1. Plus the failure path with a key that cannot work. Run by
 * hand with `npm run smoke:live`; the evidence is what this writes under
 * `.e2e-artifacts/live/`, and it contains no secret.
 */
const ARTIFACTS = path.join(__dirname, "..", "..", ".e2e-artifacts", "live");
const shot = (name: string) => path.join(ARTIFACTS, `${name}.png`);
const NAME = "Parcel lockers";

const MEETING_NOTES = `Kick-off, parcel lockers for the Lindenhof building, 3 October

Present: Maya (product lead), Ben (building management), Zoe (courier partner), Tom (resident council).

Why we are doing this: residents miss parcels because couriers come while people are at work, and the
packages end up at a shop two streets away. Maya: the point is that a resident can collect a parcel
whenever they come home, without waiting for anyone.

Who is involved. Residents of the building, obviously; they are the ones picking things up. Couriers from
three different carriers deliver here, Zoe says they need the drop-off to take under a minute or they will
skip the lockers. Ben's team (building management) owns the lobby and has to deal with broken lockers and
complaints, but they will not use the lockers themselves.

What residents need, in their words from the survey: "get my parcel on the day it arrives", "know when
something has arrived without checking the lobby", "not get stuck with a locker that will not open".
Couriers need a free compartment they can find quickly and a confirmation that the parcel is logged.

How it should go when it works: the courier scans the parcel at the locker bank and a free compartment opens;
they put the parcel in and close it; the resident gets a notification with a code; the resident comes home,
enters the code and the compartment opens; they take the parcel and the compartment is free again.

Open points: Tom asked whether oversized parcels go somewhere else — nobody knew. Ben wants to know who pays
for a damaged locker. We did not decide whether residents can forward a code to a neighbour.
`;

test.describe.configure({ mode: "serial" });

test("@live ordinary meeting text -> real provider -> proposal -> human accept -> proposed revision 1", async ({ page }) => {
  await fs.rm(LIVE_PRODUCT_FILE, { force: true });
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await page.goto("/");
  await expect(page.getByTestId("start-screen")).toBeVisible();
  // A real provider: the marker note is not shown.
  await expect(page.getByTestId("marker-hint")).toHaveCount(0);
  await page.getByTestId("product-name-input").fill(NAME);
  await page.getByTestId("transcript-input").fill(MEETING_NOTES);
  await page.screenshot({ path: shot("01-meeting-notes-pasted"), fullPage: true });

  const started = Date.now();
  const paid = await paidSubmission("smoke live", NAME, [{ label: "Pasted text", text: MEETING_NOTES }], async () => {
    const answer = page.waitForResponse((r) => r.url().endsWith("/api/bootstrap") && r.request().method() === "POST", { timeout: 240_000 });
    await page.getByTestId("structure-button").click();
    const response = await answer;
    return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
  });
  await expect(page.getByTestId("proposal-review")).toBeVisible({ timeout: 240_000 });
  const seconds = Math.round((Date.now() - started) / 1000);
  // A real model may read more than one goal into the notes (measured 2026-10-10 with claude-haiku-5-5). The human
  // picks one (AC-FUF-05), as a person would: the first. Until then the review says Accept is unavailable.
  const choice = page.getByTestId("goal-choice");
  const goalReadings = await choice.getByRole("radio").count();
  if (goalReadings) {
    await expect(page.getByTestId("proposal-accept")).toBeDisabled();
    await choice.getByRole("radio").first().check();
  }
  await expect(page.getByTestId("proposal-issues")).toHaveCount(0);

  // What came back, as the human sees it: a goal, people, needs, a path, and the open points as questions.
  const ops = page.locator("[data-testid^='diff-op-']");
  const kinds = await ops.evaluateAll((items) => items.map((item) => item.getAttribute("data-op")));
  expect(kinds).toContain("set_goal");
  expect(kinds.filter((k) => k === "add_persona").length).toBeGreaterThanOrEqual(2);
  expect(kinds.filter((k) => k === "add_need").length).toBeGreaterThanOrEqual(2);
  expect(kinds.filter((k) => k === "add_step").length).toBeGreaterThanOrEqual(3);
  expect(kinds).toContain("add_question");
  await expect(page.getByTestId("preview-goal")).not.toBeEmpty();
  await expect(page.locator("[data-testid^='source-of-op-']").first()).toHaveText("Pasted text");
  await page.screenshot({ path: shot("02-proposal-from-real-provider"), fullPage: true });
  expect(await fs.access(LIVE_PRODUCT_FILE).then(() => true, () => false)).toBe(false);

  // Human accept: the only way anything is written.
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("product-name")).toHaveText(NAME);
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByText("Revision 1", { exact: true })).toBeVisible();
  await page.screenshot({ path: shot("03-first-map-accepted"), fullPage: true });

  const stored = YAML.parse(await fs.readFile(LIVE_PRODUCT_FILE, "utf8"));
  expect(stored.revision).toEqual({ number: 1, status: "proposed" });
  expect(stored.goal.statement.length).toBeGreaterThan(10);
  expect(stored.personas.length).toBeGreaterThanOrEqual(2);
  expect(stored.narrative.length).toBeGreaterThanOrEqual(3);
  expect(stored.provenance.length).toBeGreaterThan(0);
  for (const entry of stored.provenance) {
    expect(entry.sourceId).toBe("src-1");
    expect(entry.sourceLabel).toBe("Pasted text");
    expect(MEETING_NOTES.replace(/\s+/g, " ")).toContain(entry.snippet.replace(/\s+/g, " "));
  }
  const provider = stored.provenance[0].provider as string;
  expect(provider).toMatch(/^(anthropic|openai|openrouter) \(/);

  // The record of this run, without anything secret: what was asked, what came back, how long it took.
  const record = {
    ranAt: new Date().toISOString(),
    commit: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" }).trim(),
    provider,
    serverProvider: paid.serverProvider,
    modelCalls: paid.modelCalls,
    chargedUsd: paid.chargedUsd,
    budget: await ledgerSummary(),
    goalReadings,
    secondsToProposal: seconds,
    operations: kinds.reduce<Record<string, number>>((sum, kind) => ({ ...sum, [kind!]: (sum[kind!] ?? 0) + 1 }), {}),
    accepted: { revision: stored.revision, goal: stored.goal.statement, personas: stored.personas.map((p: { name: string }) => p.name), steps: stored.narrative.map((s: { title: string }) => s.title), openQuestions: stored.decisions.map((d: { title: string }) => d.title) },
  };
  const text = JSON.stringify(record, null, 2);
  expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  await fs.writeFile(path.join(ARTIFACTS, "record.json"), text);
  await fs.copyFile(LIVE_PRODUCT_FILE, path.join(ARTIFACTS, "accepted.product.yaml"));
});

test("@bad-key a key that cannot work: the failure is visible, nothing is written, no secret is shown", async ({ page }) => {
  await fs.rm(BAD_KEY_PRODUCT_FILE, { force: true });
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await page.goto("/");
  await page.getByTestId("product-name-input").fill(NAME);
  await page.getByTestId("transcript-input").fill(MEETING_NOTES);
  // A key that cannot work costs nothing, but it is counted like any other submission: the guard does not trust the key to fail.
  await paidSubmission("smoke bad-key", NAME, [{ label: "Pasted text", text: MEETING_NOTES }], async () => {
    const answer = page.waitForResponse((r) => r.url().endsWith("/api/bootstrap") && r.request().method() === "POST", { timeout: 120_000 });
    await page.getByTestId("structure-button").click();
    const response = await answer;
    return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
  });
  const issues = page.getByTestId("proposal-issues");
  await expect(issues).toBeVisible({ timeout: 120_000 });
  await expect(issues).toContainText("rejected the credentials");
  await expect(issues).toContainText("provider_error");
  const text = await issues.textContent();
  expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  await expect(page.getByTestId("proposal-review")).toHaveCount(0);
  expect(await fs.access(BAD_KEY_PRODUCT_FILE).then(() => true, () => false)).toBe(false);
  await page.screenshot({ path: shot("04-provider-error-bad-key"), fullPage: true });
});
