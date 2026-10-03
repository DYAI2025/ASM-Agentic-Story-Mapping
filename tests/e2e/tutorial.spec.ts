import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";
import { resetProductFile } from "./global-setup";

/**
 * ASM-27: the tutorial says how ASM is used; the Product Flow says where the
 * product stands. The first is browser state, the second is read from the
 * map and the work state, and neither can change the other.
 */
const HUMAN = "Maya (E2E)";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const shot = (name: string) => path.join(SCREENSHOTS, `tutorial-${name}.png`);
const exists = (file: string) => fs.access(file).then(() => true, () => false);

test.describe.configure({ mode: "serial" });

/** What the product flow shows: the current step and the progress line, as a pair to compare before and after. */
async function flowState(page: Page) {
  return [await page.getByTestId("guide").getAttribute("data-current-step"), await page.getByTestId("guide-progress").textContent()];
}

test("first visit on the start screen: four steps, skip or finish, replay; the product flow does not move and no file appears", async ({ page }) => {
  await fs.rm(E2E_PRODUCT_FILE, { force: true });
  await fs.rm(E2E_WORK_STATE_FILE, { force: true });
  await page.goto("/");
  const tutorial = page.getByTestId("tutorial");
  await expect(tutorial).toBeVisible();
  await expect(tutorial).toHaveAttribute("data-step", "1");
  await expect(tutorial).toBeFocused();
  await expect(page.getByTestId("tutorial-title")).toHaveText("Bring what you already have");
  // The product flow is there too, as its own thing, at its first step.
  await expect(page.getByRole("region", { name: "Product Flow" })).toBeVisible();
  await expect(page.getByTestId("guide-lead")).toContainText("nothing here is a tutorial");
  const before = await flowState(page);
  expect(before).toEqual(["intent", "0 of 7 steps done"]);
  await page.screenshot({ path: shot("01-step-1-on-start-screen"), fullPage: true });

  // Through all four steps.
  await page.getByTestId("tutorial-next").click();
  await expect(page.getByTestId("tutorial-title")).toHaveText("Review, don't rewrite");
  await page.screenshot({ path: shot("02-step-2"), fullPage: true });
  await page.getByTestId("tutorial-back").click();
  await expect(tutorial).toHaveAttribute("data-step", "1");
  await page.getByTestId("tutorial-next").click();
  await page.getByTestId("tutorial-next").click();
  await expect(page.getByTestId("tutorial-title")).toHaveText("Check the story");
  await page.screenshot({ path: shot("03-step-3"), fullPage: true });
  await page.getByTestId("tutorial-next").click();
  await expect(tutorial).toHaveAttribute("data-step", "4");
  await expect(page.getByTestId("tutorial-title")).toHaveText("Turn understanding into work");
  await expect(page.getByTestId("tutorial-next")).toHaveCount(0);
  await page.screenshot({ path: shot("04-step-4"), fullPage: true });
  await page.getByTestId("tutorial-finish").click();
  await expect(tutorial).toHaveCount(0);
  await expect(page.getByTestId("tutorial-replay")).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("asm.tutorial"))).toBe("done");
  // Finishing changed nothing about the product: same flow state, still no file.
  expect(await flowState(page)).toEqual(before);
  expect(await exists(E2E_PRODUCT_FILE)).toBe(false);

  // Seen once: not shown again on reload. Replay brings it back at step 1; Skip ends it; Escape ends it too.
  await page.reload();
  await expect(page.getByTestId("tutorial")).toHaveCount(0);
  await expect(page.getByTestId("tutorial-replay")).toBeVisible();
  await page.getByTestId("tutorial-replay").click();
  await expect(page.getByTestId("tutorial")).toHaveAttribute("data-step", "1");
  await page.getByTestId("tutorial-skip").click();
  await expect(page.getByTestId("tutorial")).toHaveCount(0);
  await page.getByTestId("tutorial-replay").click();
  await page.getByTestId("tutorial-next").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tutorial")).toHaveCount(0);
  expect(await flowState(page)).toEqual(before);
  expect(await exists(E2E_PRODUCT_FILE)).toBe(false);
  await page.screenshot({ path: shot("05-after-tutorial-product-flow-only"), fullPage: true });
});

test("on an approved, selected map: the tutorial opens and closes without touching the product flow, the files, or the hidden-flow preference", async ({ page }) => {
  await resetProductFile();
  await page.goto("/");
  // A fresh browser context: the tutorial shows here too; close it, then build real state.
  await page.getByTestId("tutorial-skip").click();
  await page.getByLabel("Approver name").fill(HUMAN);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await page.getByTestId("slices-open").click();
  await page.getByLabel("Confirmed by").fill(HUMAN);
  await page.getByTestId("people-check-confirm").click();
  await page.getByLabel("Selector name").fill(HUMAN);
  await page.getByTestId("select-slice-outcome-thread").click();
  await expect(page.getByTestId("selection-record")).toBeVisible();
  await page.getByTestId("slices-close").click();
  const before = await flowState(page);
  expect(before).toEqual(["complete", "7 of 7 steps done"]);
  const productBefore = sha(await fs.readFile(E2E_PRODUCT_FILE, "utf8"));
  const workBefore = sha(await fs.readFile(E2E_WORK_STATE_FILE, "utf8"));

  await page.getByTestId("tutorial-replay").click();
  await expect(page.getByTestId("tutorial")).toBeVisible();
  for (let i = 0; i < 3; i++) await page.getByTestId("tutorial-next").click();
  await page.getByTestId("tutorial-finish").click();
  await expect(page.getByTestId("tutorial")).toHaveCount(0);

  expect(await flowState(page)).toEqual(before);
  expect(sha(await fs.readFile(E2E_PRODUCT_FILE, "utf8"))).toBe(productBefore);
  expect(sha(await fs.readFile(E2E_WORK_STATE_FILE, "utf8"))).toBe(workBefore);
  // The two preferences are separate keys: finishing the tutorial does not hide the product flow, hiding the flow does not reset the tutorial.
  expect(await page.evaluate(() => [window.localStorage.getItem("asm.tutorial"), window.localStorage.getItem("asm.guide")])).toEqual(["done", null]);
  await page.getByTestId("guide-hide").click();
  await expect(page.getByTestId("guide-show")).toHaveText("Show product flow");
  expect(await page.evaluate(() => [window.localStorage.getItem("asm.tutorial"), window.localStorage.getItem("asm.guide")])).toEqual(["done", "off"]);
  await expect(page.getByTestId("tutorial")).toHaveCount(0);
  await page.getByTestId("guide-show").click();
  await expect(page.getByRole("region", { name: "Product Flow" })).toBeVisible();
  await expect(page.getByTestId("guide-hide")).toHaveText("Hide product flow");
});
