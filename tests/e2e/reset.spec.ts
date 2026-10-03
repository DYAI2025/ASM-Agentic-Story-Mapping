import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";
import { resetProductFile } from "./global-setup";

/**
 * ASM-23: clear input and start over are two different actions. Clear touches
 * only what was typed; start over, confirmed, removes the user-workspace product
 * and its work state and brings the start screen back without a server restart.
 * Both are proven against the files on disk, not only the DOM.
 */
const HUMAN = "Maya (E2E)";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetProductFile);

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const storedText = () => fs.readFile(E2E_PRODUCT_FILE, "utf8");
const workStateText = () => fs.readFile(E2E_WORK_STATE_FILE, "utf8");
const exists = (file: string) => fs.access(file).then(() => true, () => false);
const shot = (name: string) => path.join(SCREENSHOTS, `reset-${name}.png`);

/** Approve, confirm who else matters, select a slice: a product with every kind of work state on it. */
async function populate(page: Page) {
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
  await expect(page.getByTestId("selected-slice-badge")).toBeVisible();
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(200);
}

test("clear input empties only the text; the product file and the work state are byte-identical afterwards", async ({ page }) => {
  await populate(page);
  const productBefore = sha(await storedText());
  const workBefore = sha(await workStateText());

  const input = page.getByTestId("transcript-input");
  await expect(page.getByTestId("clear-input")).toBeDisabled();
  await input.fill("Goal: Something typed and never sent.\nPersona: Nobody");
  await expect(page.getByTestId("clear-input")).toBeEnabled();
  await page.getByTestId("clear-input").click();
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("proposal-status")).toHaveText("Input cleared. The map was not changed.");
  await expect(page.getByTestId("clear-input")).toBeDisabled();

  // A proposal under review goes too: it was never accepted, so it was never on the map.
  await input.fill("Goal: A goal typed only to be cleared.");
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await expect(page.getByTestId("clear-input")).toHaveCount(0);
  await page.getByTestId("proposal-reject").click();
  await expect(page.getByTestId("proposal-review")).toHaveCount(0);
  await page.getByTestId("clear-input").click();
  await expect(input).toHaveValue("");

  expect(sha(await storedText())).toBe(productBefore);
  expect(sha(await workStateText())).toBe(workBefore);
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await expect(page.getByTestId("selected-slice-badge")).toBeVisible();
});

test("start over asks first; cancel changes nothing on disk or on screen", async ({ page }) => {
  await populate(page);
  const productBefore = sha(await storedText());
  const workBefore = sha(await workStateText());

  await expect(page.getByTestId("start-over-dialog")).toHaveCount(0);
  await page.getByTestId("start-over").click();
  const dialog = page.getByRole("dialog", { name: "Start over?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("There is no undo");
  await page.screenshot({ path: shot("01-confirmation"), fullPage: true });
  await page.getByTestId("start-over-cancel").click();
  await expect(page.getByTestId("start-over-dialog")).toHaveCount(0);

  expect(sha(await storedText())).toBe(productBefore);
  expect(sha(await workStateText())).toBe(workBefore);
  await expect(page.getByTestId("product-name")).toHaveText("ASM – Agentic Story Mapping");
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await expect(page.getByTestId("selected-slice-badge")).toBeVisible();
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(200);
});

test("start over, confirmed: product and work state gone, start screen back, nothing old left effective; a new product starts clean", async ({ page }) => {
  await populate(page);
  await page.screenshot({ path: shot("02-before"), fullPage: true });

  await page.getByTestId("start-over").click();
  await page.getByTestId("start-over-confirm").click();

  // The server answered and the page reloaded: no product, so the start screen.
  await expect(page.getByTestId("start-screen")).toBeVisible();
  expect(await exists(E2E_PRODUCT_FILE)).toBe(false);
  expect(await exists(E2E_WORK_STATE_FILE)).toBe(false);
  await page.screenshot({ path: shot("03-fresh-start"), fullPage: true });

  // Every route that needs a product says so; nothing derived from the old one answers.
  for (const url of ["/api/product", "/api/slices", "/api/brief?format=json"]) {
    const response = await page.request.get(url);
    expect(response.status(), url).toBe(404);
    expect((await response.json()).issues[0].code, url).toBe("no_product");
  }
  // A second reset has nothing to remove.
  const again = await page.request.post("/api/product/reset", { data: { confirm: "start over" } });
  expect(again.status()).toBe(404);

  // Start a new product right away, in the same server: the old people check, selection and brief are not there.
  await page.getByTestId("product-name-input").fill("Parcel lockers");
  await page.getByTestId("transcript-input").fill(
    [
      "Goal: Residents collect a parcel without waiting for a courier.",
      "Persona: Resident — Lives in the building. [roles: customer, user]",
      "Need (Resident): Get my parcel on the day it arrives.",
      "Step: Resident opens the compartment — With a code. [personas: Resident] [needs: Get my parcel on the day it arrives]",
    ].join("\n"),
  );
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("product-name")).toHaveText("Parcel lockers");
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByTestId("selected-slice-badge")).toHaveCount(0);
  await expect(page.getByTestId("stale-slice-badge")).toHaveCount(0);
  await expect(page.getByTestId("stale-people-check-badge")).toHaveCount(0);
  // One step on the map: the product flow starts at laying out the path, nothing downstream is done or stale.
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "main_path");
  await expect(page.getByTestId("guide-step-people_check")).toHaveAttribute("data-status", "upcoming");
  await expect(page.getByTestId("guide-step-select")).toHaveAttribute("data-status", "upcoming");
  await expect(page.locator("[data-testid^='guide-stale-']")).toHaveCount(0);
  expect(await exists(E2E_WORK_STATE_FILE)).toBe(false);
  const slices = await (await page.request.get("/api/slices")).json();
  expect(slices.selection).toBeNull();
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(409);
  await page.screenshot({ path: shot("04-new-product-after-reset"), fullPage: true });
});

test("a reset request without the confirmation words is refused and removes nothing", async ({ page }) => {
  await populate(page);
  for (const data of [{}, { confirm: true }, { confirm: "yes" }]) {
    const response = await page.request.post("/api/product/reset", { data });
    expect(response.status()).toBe(400);
  }
  expect(await exists(E2E_PRODUCT_FILE)).toBe(true);
  expect(await exists(E2E_WORK_STATE_FILE)).toBe(true);
  await page.reload();
  await expect(page.getByTestId("selected-slice-badge")).toBeVisible();
});
