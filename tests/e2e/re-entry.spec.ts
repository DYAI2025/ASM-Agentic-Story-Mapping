import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";
import { resetProductFile } from "./global-setup";

const HUMAN = "Maya (E2E)";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetProductFile);

const storedText = () => fs.readFile(E2E_PRODUCT_FILE, "utf8");
const workStateText = () => fs.readFile(E2E_WORK_STATE_FILE, "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const shot = (name: string) => path.join(SCREENSHOTS, `re-entry-${name}.png`);

/** Approve, confirm who else matters, select a slice: the state every scenario starts from. */
async function reachWorkOrder(page: Page) {
  await page.goto("/");
  await page.getByLabel("Approver name").fill(HUMAN);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await page.getByTestId("slices-open").click();
  await page.getByLabel("Confirmed by").fill(HUMAN);
  await page.getByTestId("people-check-confirm").click();
  await expect(page.getByTestId("people-check-record")).toBeVisible();
  await page.getByLabel("Selector name").fill(HUMAN);
  await page.getByTestId("select-slice-outcome-thread").click();
  await expect(page.getByTestId("selection-record")).toBeVisible();
  await page.getByTestId("slices-close").click();
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "complete");
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(200);
}

/** What every change of meaning has to lead to, and what it must not touch. */
async function expectBackAtApproval(page: Page, workStateBefore: string, label: string) {
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "approve");
  await expect(page.getByTestId("guide-step-people_check")).toHaveAttribute("data-status", "upcoming");
  await expect(page.getByTestId("guide-step-select")).toHaveAttribute("data-status", "upcoming");
  await expect(page.getByTestId("guide-step-work_order")).toHaveAttribute("data-status", "upcoming");
  await expect(page.getByTestId("guide-stale-people_check")).toBeVisible();
  await expect(page.getByTestId("guide-stale-select")).toBeVisible();
  await expect(page.getByTestId("guide-stale-note")).toContainText("nothing was deleted or chosen for you");
  await expect(page.getByTestId("stale-slice-badge")).toBeVisible();
  await expect(page.getByTestId("stale-people-check-badge")).toBeVisible();
  await expect(page.getByTestId("stale-summary")).toContainText("approve the story, then confirm who else matters, then pick a slice again");
  await expect(page.getByTestId("impact-delivery")).toHaveCount(0);
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(409);
  // Nothing in the work state was deleted or repaired by the change.
  expect(sha(await workStateText())).toBe(sha(workStateBefore));
  await page.screenshot({ path: shot(label), fullPage: true });
}

test("the goal changes: back at approval, everything downstream stale and explained, nothing deleted", async ({ page }) => {
  await reachWorkOrder(page);
  const workStateBefore = await workStateText();
  const goal = page.getByTestId(`card-${YAML.parse(await storedText()).goal.id}`);
  await goal.getByRole("button", { name: /^Edit/ }).click();
  await goal.locator("textarea[name='statement']").fill("Teams reach a shared narrative in one afternoon.");
  await goal.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("goal-statement")).toHaveText("Teams reach a shared narrative in one afternoon.");
  await expectBackAtApproval(page, workStateBefore, "01-goal-changed");
});

test("a need changes: the same way back", async ({ page }) => {
  await reachWorkOrder(page);
  const workStateBefore = await workStateText();
  // The editor shows needs as text on the person's card and has no need editor yet; the change comes in as a saved document.
  const doc = YAML.parse(await storedText());
  doc.needs.find((n: { id: string }) => n.id === "need-buildable-slice").statement = "Receive a first slice that is small and clear.";
  doc.revision = { number: doc.revision.number + 1, status: "proposed" };
  const put = await page.request.put("/api/product", { data: YAML.stringify(doc) });
  expect(put.status()).toBe(200);
  await page.reload();
  await expectBackAtApproval(page, workStateBefore, "02-need-changed");
});

test("the path order changes: the same way back; then approve, confirm and pick again lead to a new work order", async ({ page }) => {
  await reachWorkOrder(page);
  const workStateBefore = await workStateText();
  await page.getByRole("button", { name: "Move step-export-work earlier in narrative" }).click();
  await expectBackAtApproval(page, workStateBefore, "03-path-reordered");

  // The way back, step by step; each stale record is replaced only by its own human action.
  await page.getByLabel("Approver name").fill(HUMAN);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "people_check");
  await expect(page.getByTestId("stale-people-check-badge")).toBeVisible();
  await expect(page.getByTestId("stale-summary")).toContainText("confirm who else matters, then pick a slice again");
  expect(sha(await workStateText())).toBe(sha(workStateBefore));

  await page.getByTestId("slices-open").click();
  await expect(page.getByTestId("people-check")).toHaveAttribute("data-state", "stale");
  await expect(page.getByTestId("slice-gate")).toHaveAttribute("data-selection-state", "stale");
  await page.getByTestId("slice-drawer").screenshot({ path: shot("04-drawer-both-stale") });
  await page.getByLabel("Confirmed by").fill(HUMAN);
  await page.getByTestId("people-check-confirm").click();
  await expect(page.getByTestId("people-check")).toHaveAttribute("data-state", "current");
  await expect(page.getByTestId("slice-gate")).toHaveAttribute("data-selection-state", "stale");
  await page.getByTestId("slices-close").click();
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "select");
  await expect(page.getByTestId("stale-people-check-badge")).toHaveCount(0);
  await expect(page.getByTestId("stale-slice-badge")).toBeVisible();
  await expect(page.getByTestId("stale-summary")).toContainText("then pick a slice again");

  await page.getByTestId("slices-open").click();
  await page.getByTestId("reselect-candidates").click();
  await page.getByLabel("Selector name").fill(HUMAN);
  await page.getByTestId("select-slice-outcome-thread").click();
  await expect(page.getByTestId("selection-record")).toBeVisible();
  await page.getByTestId("slices-close").click();
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "complete");
  await expect(page.getByTestId("stale-summary")).toHaveCount(0);
  const brief = await page.request.get("/api/brief?format=json");
  expect(brief.status()).toBe(200);
  // The new work order is bound to the new map, not the old one.
  expect((await brief.json()).sourceMapRevision.mapFingerprint).not.toBe(JSON.parse(workStateBefore).selection.mapFingerprint);
  await page.screenshot({ path: shot("05-way-back-complete"), fullPage: true });
});

test("a layout-only change invalidates nothing", async ({ page }) => {
  await reachWorkOrder(page);
  const workStateBefore = await workStateText();
  await page.getByRole("button", { name: "Nudge step-main-path down visually" }).click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "complete");
  await expect(page.getByTestId("stale-summary")).toHaveCount(0);
  await expect(page.getByTestId("stale-slice-badge")).toHaveCount(0);
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(200);
  expect(sha(await workStateText())).toBe(sha(workStateBefore));
});

test("looking at stale state repairs nothing: reads, reloads and the drawer leave the records as they are", async ({ page }) => {
  await reachWorkOrder(page);
  const workStateBefore = await workStateText();
  await page.getByRole("button", { name: "Move step-export-work earlier in narrative" }).click();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await page.getByTestId("slices-open").click();
    await expect(page.getByTestId("slice-gate")).toHaveAttribute("data-selection-state", "stale");
    await page.getByTestId("slices-close").click();
    expect((await page.request.get("/api/slices")).status()).toBe(200);
    expect((await page.request.get("/api/brief?format=md")).status()).toBe(409);
  }
  expect(sha(await workStateText())).toBe(sha(workStateBefore));
});
