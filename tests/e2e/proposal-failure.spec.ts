import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_REPAIR_PRODUCT_FILE, E2E_REPAIR_WORK_STATE_FILE, MODEL_STUB_KEY, MODEL_STUB_PORT, REPAIR_PORT } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";
import { FIXTURE_FILE } from "./global-setup";

/**
 * ASM-30: when the model's answer cannot be read, the human gets one bounded
 * message (what happened, that nothing changed, what to do next) and the
 * technical list behind a closed disclosure, never a wall of schema paths.
 * Failures that already speak for themselves (credentials, rate limit, a
 * quote not in the text, a discarded secret) keep their specific message.
 * The app runs its real `openai` adapter against the scripted model of
 * `model-stub-server.ts`; no real model and no real key.
 */
test.use({ baseURL: `http://127.0.0.1:${REPAIR_PORT}` });
test.describe.configure({ mode: "serial" });

const STUB = `http://127.0.0.1:${MODEL_STUB_PORT}`;
const LINES = [
  "Goal: Residents collect parcels whenever they come home.",
  "Persona: Resident — Lives in the building and receives parcels.",
];
for (let i = 1; i <= 10; i++)
  LINES.push(`Need (Resident): Know when parcel ${i} has arrived.`, `Step: Collect parcel ${i} — The resident opens compartment ${i}. [personas: Resident]`);
const TEXT = LINES.join("\n");
/** An answer in the wrong shape on both calls, large enough for 50+ issues (74 at 4bab8e0). */
const WIDE_FAILURE = `${TEXT}\n[stub:never-in-shape]`;
const SHORT = LINES.slice(0, 4).join("\n");

const HEADLINE = "The model's answer could not be read safely, so ASM did not use it.";
/** What a schema dump looks like: the codes, the paths, the validator's own words. */
const SCHEMA_TALK = /agent_output_|\bneeds\.\d|\bsteps\.\d|Unrecognized key|Invalid input/;

const exists = (file: string) => fs.access(file).then(() => true, () => false);
const shot = (name: string) => path.join(SCREENSHOTS, `proposal-failure-${name}.png`);

test.beforeEach(async () => {
  await fs.mkdir(path.dirname(E2E_REPAIR_PRODUCT_FILE), { recursive: true });
  await fs.rm(E2E_REPAIR_PRODUCT_FILE, { force: true });
  await fs.rm(E2E_REPAIR_WORK_STATE_FILE, { force: true });
  await fetch(`${STUB}/reset`, { method: "POST" });
});

type Answer = { status: number; raw: string; issues: Array<{ code: string; path: string; message: string }> };

async function structure(page: Page, route: "/api/bootstrap" | "/api/proposal", text: string): Promise<Answer> {
  await page.getByTestId("transcript-input").fill(text);
  const response = page.waitForResponse((r) => r.url().endsWith(route) && r.request().method() === "POST");
  await page.getByTestId("structure-button").click();
  const answer = await response;
  const raw = await answer.text();
  return { status: answer.status(), raw, issues: (JSON.parse(raw) as { issues?: Answer["issues"] }).issues ?? [] };
}

/** The bounded message with its disclosure closed: what a first-time user reads. */
async function expectBoundedMessage(page: Page, answer: Answer) {
  expect(answer.status).toBe(422);
  expect(answer.issues.length).toBeGreaterThanOrEqual(50);
  expect(answer.issues.every((issue) => issue.code.startsWith("agent_output_"))).toBe(true);

  const box = page.getByTestId("proposal-issues");
  await expect(box).toBeVisible();
  await expect(page.getByTestId("proposal-failure-headline")).toHaveText(HEADLINE);
  await expect(page.getByTestId("proposal-failure-unchanged")).toHaveText("Nothing was changed.");
  await expect(page.getByTestId("proposal-failure-next").locator("li")).toHaveCount(3);

  // Announced, not only painted: the box is an alert, as the issue list was before (verifier round 1).
  await expect(page.getByRole("alert").filter({ hasText: HEADLINE })).toBeVisible();

  // What is on screen: a few sentences whatever the number of issues, and none of the validator's language.
  // innerText leaves out what a closed disclosure hides, so these sentences are checked as read, not as markup.
  const visible = await box.innerText();
  expect(visible).toContain(HEADLINE);
  expect(visible).toContain("Nothing was changed.");
  expect(visible).toContain("Try again");
  expect(visible.length).toBeLessThanOrEqual(700);
  expect(visible).not.toMatch(SCHEMA_TALK);
  for (const issue of answer.issues) expect(visible).not.toContain(issue.path);

  // The technical list is there, behind a disclosure that starts closed.
  const details = page.getByTestId("proposal-failure-details");
  await expect(details).toHaveJSProperty("open", false);
  await expect(details.locator("summary")).toHaveText(`Technical details (${answer.issues.length} problems in the answer)`);
  await expect(details.locator("li").first()).toBeHidden();
}

test("first map, 50+ issues: one bounded message, nothing created, the technical list only on request", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("product-name-input").fill("Parcel lockers");
  const answer = await structure(page, "/api/bootstrap", WIDE_FAILURE);
  await expectBoundedMessage(page, answer);
  await expect(page.getByTestId("proposal-review")).toHaveCount(0);
  await page.screenshot({ path: shot("01-bounded-message"), fullPage: true });

  // Opened by the human: every issue the server returned, with path, message and code.
  const details = page.getByTestId("proposal-failure-details");
  await details.locator("summary").click();
  await expect(details).toHaveJSProperty("open", true);
  await expect(details.locator("li")).toHaveCount(answer.issues.length);
  await expect(details.locator("li").first()).toBeVisible();
  await expect(details).toContainText(answer.issues[0].path);
  await expect(details).toContainText(answer.issues[0].code);
  await page.screenshot({ path: shot("02-technical-details-open"), fullPage: true });

  // No key anywhere: not on the page, open or closed, and not in the response.
  expect(await page.content()).not.toContain(MODEL_STUB_KEY);
  expect(answer.raw).not.toContain(MODEL_STUB_KEY);
  expect(await exists(E2E_REPAIR_PRODUCT_FILE)).toBe(false);
  expect(await exists(E2E_REPAIR_WORK_STATE_FILE)).toBe(false);
});

test("existing map, 50+ issues: the same message, and the product file and the work state stay byte-identical", async ({ page }) => {
  await fs.copyFile(FIXTURE_FILE, E2E_REPAIR_PRODUCT_FILE);
  const workState = JSON.stringify({ workStateVersion: 1 });
  await fs.writeFile(E2E_REPAIR_WORK_STATE_FILE, workState);
  const before = await fs.readFile(E2E_REPAIR_PRODUCT_FILE, "utf8");
  await page.goto("/");
  await expect(page.getByTestId("goal-statement")).toBeVisible();

  const answer = await structure(page, "/api/proposal", WIDE_FAILURE);
  await expectBoundedMessage(page, answer);
  await expect(page.getByTestId("proposal-review")).toHaveCount(0);
  expect(await fs.readFile(E2E_REPAIR_PRODUCT_FILE, "utf8")).toBe(before);
  expect(await fs.readFile(E2E_REPAIR_WORK_STATE_FILE, "utf8")).toBe(workState);

  // A second try that works replaces the message with a proposal; the map still changes only on Accept.
  await page.getByTestId("transcript-input").fill(SHORT);
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await expect(page.getByTestId("proposal-issues")).toHaveCount(0);
  expect(await fs.readFile(E2E_REPAIR_PRODUCT_FILE, "utf8")).toBe(before);
});

/** A failure that keeps its own words: listed as before, no summary headline, no disclosure. */
async function expectSpecific(page: Page, answer: Answer, code: string, words: string) {
  const box = page.getByTestId("proposal-issues");
  await expect(box).toBeVisible();
  await expect(box).toContainText("No proposal.");
  await expect(box).toContainText(words);
  await expect(box).toContainText(code);
  await expect(page.getByTestId("proposal-failure-headline")).toHaveCount(0);
  await expect(page.getByTestId("proposal-failure-details")).toHaveCount(0);
  expect(answer.issues.map((issue) => issue.code)).toContain(code);
  expect(await page.content()).not.toContain(MODEL_STUB_KEY);
  expect(answer.raw).not.toContain(MODEL_STUB_KEY);
  expect(await exists(E2E_REPAIR_PRODUCT_FILE)).toBe(false);
}

test("rejected credentials keep their specific message", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("product-name-input").fill("Parcel lockers");
  const answer = await structure(page, "/api/bootstrap", `${SHORT}\n[stub:status-401]`);
  expect(answer.status).toBe(502);
  await expectSpecific(page, answer, "provider_error", "OpenAI rejected the credentials; check OPENAI_API_KEY");
});

test("a rate limit keeps its specific message", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("product-name-input").fill("Parcel lockers");
  const answer = await structure(page, "/api/bootstrap", `${SHORT}\n[stub:status-429]`);
  expect(answer.status).toBe(502);
  await expectSpecific(page, answer, "provider_error", "OpenAI rate limit reached; try again shortly");
});

test("a quote that is not in the text, still wrong after the repair, keeps its specific message", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("product-name-input").fill("Parcel lockers");
  const answer = await structure(page, "/api/bootstrap", `${SHORT}\n[stub:inexact-quote-always]`);
  expect(answer.status).toBe(422);
  expect(answer.issues.every((issue) => issue.code === "snippet_not_in_source")).toBe(true);
  await expectSpecific(page, answer, "snippet_not_in_source", answer.issues[0].message);
});

test("an answer carrying the key is discarded whole; the key is in neither the message nor any detail", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("product-name-input").fill("Parcel lockers");
  const answer = await structure(page, "/api/bootstrap", `${SHORT}\n[stub:leak-key]`);
  expect(answer.status).toBe(502);
  await expectSpecific(page, answer, "provider_error", "the model's output contained a configured secret and was discarded");
});

test("the key as a field name alone is discarded the same way: an unrecognized key would otherwise be quoted in the details", async ({ page }) => {
  // Found by the verifier on 14e9006: with the key in both name and value, a check of values alone passed too.
  await page.goto("/");
  await page.getByTestId("product-name-input").fill("Parcel lockers");
  const answer = await structure(page, "/api/bootstrap", `${SHORT}\n[stub:leak-key-name]`);
  expect(answer.status).toBe(502);
  await expectSpecific(page, answer, "provider_error", "the model's output contained a configured secret and was discarded");
});
