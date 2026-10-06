import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";
import { resetProductFile } from "./global-setup";

/**
 * ASM-31: on an existing product the old goal keeps a proposal valid even with
 * every goal reading left out, so validity cannot be the gate. With several
 * readings, Accept stays unavailable until the human has chosen exactly one,
 * the screen says so in words, and accepting applies that reading and no other.
 * Nothing is written before Accept.
 */
const FIRST = "Teams agree on one product narrative before they plan any delivery.";
const SECOND = "Product leads hand agents a work order they can execute without asking.";
const TEXT = [`Goal: ${FIRST}`, `Goal: ${SECOND}`, "Do we ship the export first?"].join("\n");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const stored = () => fs.readFile(E2E_PRODUCT_FILE, "utf8");
const workStateExists = () => fs.access(E2E_WORK_STATE_FILE).then(() => true, () => false);
const shot = (name: string) => path.join(SCREENSHOTS, `goal-choice-${name}.png`);
const reading = (page: Page, statement: string) =>
  page.getByTestId("goal-choice").locator(".diff-entry", { hasText: statement }).locator("input[type='radio']");

/** Every body the browser sent to the accept route, as parsed JSON. */
function acceptRequests(page: Page) {
  const sent: Array<{ patch: { operations: Array<{ op: string; statement?: string }> } }> = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/accept")) sent.push(request.postDataJSON());
  });
  return sent;
}

async function proposeTwoReadings(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("goal-statement")).toBeVisible();
  await page.getByTestId("transcript-input").fill(TEXT);
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await expect(page.locator("input[name='goal-choice']")).toHaveCount(2);
}

async function acceptAndRead(page: Page) {
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("proposal-review")).toHaveCount(0);
  return YAML.parse(await stored());
}

test.describe.configure({ mode: "serial" });
test.beforeEach(resetProductFile);

test("existing product, two readings, none chosen: Accept is unavailable, the screen says why, nothing is written", async ({ page }) => {
  const before = await stored();
  const oldGoal = YAML.parse(before).goal.statement;
  const sent = acceptRequests(page);
  await proposeTwoReadings(page);

  await expect(page.locator("input[name='goal-choice']:checked")).toHaveCount(0);
  await expect(page.getByTestId("proposal-accept")).toBeDisabled();
  const notice = page.getByTestId("goal-choice-required");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Choose exactly one goal reading");
  await expect(page.getByTestId("proposal-accept")).toHaveAttribute("aria-describedby", "goal-choice-required");
  await page.screenshot({ path: shot("01-none-chosen-blocked"), fullPage: true });

  // A forced click on the unavailable button sends nothing and changes nothing.
  await page.getByTestId("proposal-accept").click({ force: true });
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  expect(sent).toHaveLength(0);
  expect(sha(await stored())).toBe(sha(before));
  expect(YAML.parse(await stored()).goal.statement).toBe(oldGoal);
  expect(await workStateExists()).toBe(false);
});

test("choose the first reading: Accept becomes available, and the new revision has that goal and not the other", async ({ page }) => {
  const before = await stored();
  const revision = YAML.parse(before).revision.number;
  const sent = acceptRequests(page);
  await proposeTwoReadings(page);

  await reading(page, FIRST).check();
  await expect(page.locator("input[name='goal-choice']:checked")).toHaveCount(1);
  await expect(page.getByTestId("goal-choice-required")).toHaveCount(0);
  await expect(page.getByTestId("proposal-accept")).toBeEnabled();
  await expect(page.getByTestId("proposal-accept")).not.toHaveAttribute("aria-describedby", "goal-choice-required");
  await page.screenshot({ path: shot("02-one-chosen-eligible"), fullPage: true });
  // Chosen, not accepted: still nothing written.
  expect(sha(await stored())).toBe(sha(before));
  expect(await workStateExists()).toBe(false);

  const doc = await acceptAndRead(page);
  expect(doc.goal.statement).toBe(FIRST);
  expect(doc.revision).toMatchObject({ number: revision + 1, status: "proposed" });
  expect(await stored()).not.toContain(SECOND);
  expect(sent).toHaveLength(1);
  expect(sent[0].patch.operations.filter((o) => o.op === "set_goal").map((o) => o.statement)).toEqual([FIRST]);
  await expect(page.getByTestId("goal-statement")).toHaveText(FIRST);
});

test("choose the second reading: the new revision has that goal and not the first", async ({ page }) => {
  const sent = acceptRequests(page);
  await proposeTwoReadings(page);

  await reading(page, SECOND).check();
  await expect(page.getByTestId("proposal-accept")).toBeEnabled();
  const doc = await acceptAndRead(page);
  expect(doc.goal.statement).toBe(SECOND);
  expect(await stored()).not.toContain(FIRST);
  expect(sent[0].patch.operations.filter((o) => o.op === "set_goal").map((o) => o.statement)).toEqual([SECOND]);
});

test("first, then second: only the last explicit choice is accepted", async ({ page }) => {
  const before = await stored();
  const sent = acceptRequests(page);
  await proposeTwoReadings(page);

  await reading(page, FIRST).check();
  await reading(page, SECOND).check();
  await expect(reading(page, FIRST)).not.toBeChecked();
  await expect(page.locator("input[name='goal-choice']:checked")).toHaveCount(1);
  expect(sha(await stored())).toBe(sha(before));

  const doc = await acceptAndRead(page);
  expect(doc.goal.statement).toBe(SECOND);
  expect(await stored()).not.toContain(FIRST);
  expect(sent).toHaveLength(1);
  expect(sent[0].patch.operations.filter((o) => o.op === "set_goal").map((o) => o.statement)).toEqual([SECOND]);
});

test("Bootstrap follows the same rule: two readings, none chosen, the same notice and no Accept", async ({ page }) => {
  await fs.rm(E2E_PRODUCT_FILE, { force: true });
  await page.goto("/");
  await page.getByTestId("product-name-input").fill("Parcel lockers");
  await page.getByTestId("transcript-input").fill(TEXT);
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();

  await expect(page.locator("input[name='goal-choice']:checked")).toHaveCount(0);
  await expect(page.getByTestId("proposal-accept")).toBeDisabled();
  await expect(page.getByTestId("goal-choice-required")).toContainText("Choose exactly one goal reading");
  await reading(page, SECOND).check();
  await expect(page.getByTestId("goal-choice-required")).toHaveCount(0);
  await expect(page.getByTestId("proposal-accept")).toBeEnabled();
  await expect(fs.access(E2E_PRODUCT_FILE)).rejects.toThrow();
});

test("the workshop accept route still refuses a patch with both readings as conflicting_goal, and the file is untouched", async ({ page }) => {
  const before = await stored();
  await page.goto("/");
  const proposed = await page.request.post("/api/proposal", {
    data: { context: { sources: [{ id: "src-1", label: "Pasted text", kind: "pasted", text: TEXT }] } },
  });
  expect(proposed.status()).toBe(200);
  const { patch } = await proposed.json();
  expect(patch.operations.filter((o: { op: string }) => o.op === "set_goal")).toHaveLength(2);
  const both = await page.request.post("/api/proposal/accept", { data: { patch } });
  expect(both.status()).toBe(422);
  expect((await both.json()).issues.map((i: { code: string }) => i.code)).toEqual(["conflicting_goal"]);
  expect(sha(await stored())).toBe(sha(before));
});
