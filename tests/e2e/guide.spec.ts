import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Request } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";
import { resetProductFile } from "./global-setup";

const HUMAN = "Maya (E2E)";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetProductFile);

const storedText = () => fs.readFile(E2E_PRODUCT_FILE, "utf8");
const workStateExists = () => fs.access(E2E_WORK_STATE_FILE).then(() => true, () => false);
/**
 * Presses the guide's button and returns every request it caused that is not a GET.
 * The guide may open and focus; it must not send anything. Requests are recorded when
 * they are sent, so a write is seen even if its effect has not landed yet.
 */
async function pressGuideButton(page: Page): Promise<string[]> {
  const sent: string[] = [];
  const record = (request: Request) => {
    if (request.method() !== "GET") sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
  };
  page.on("request", record);
  await page.getByTestId("guide-cta").focus();
  await page.keyboard.press("Enter");
  // Long enough for a request started by the key press to be sent.
  await page.waitForTimeout(500);
  page.off("request", record);
  return sent;
}

const shot = (name: string) => path.join(SCREENSHOTS, `guide-${name}.png`);

// The guide's own buttons are activated with the keyboard (focus, then Enter). The existing forms are used as they are.
test("the guide follows the real state from approval to work order", async ({ page }) => {
  await page.goto("/");
  const guide = page.getByTestId("guide");
  await expect(guide).toHaveAttribute("data-current-step", "approve");
  await expect(page.getByTestId("guide-progress")).toHaveText("3 of 6 steps done");
  await expect(guide.locator("[aria-current='step']")).toHaveCount(1);
  await expect(page.getByTestId("impact-map")).toBeVisible();
  await expect(page.getByTestId("impact-sensemaking")).toHaveCount(0);
  await page.screenshot({ path: shot("01-approve-is-current"), fullPage: true });

  // The call to action takes the human to the approval form. It approves nothing.
  const before = await storedText();
  expect(await pressGuideButton(page)).toEqual([]);
  await expect(page.getByLabel("Approver name")).toBeFocused();
  await expect(page.getByTestId("review-panel")).toBeVisible();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(guide).toHaveAttribute("data-current-step", "approve");
  expect(await storedText()).toBe(before);

  // The human approves in the existing form; only then does the guide move on.
  await page.keyboard.type(HUMAN);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await expect(guide).toHaveAttribute("data-current-step", "select");
  await expect(page.getByTestId("impact-sensemaking")).toBeVisible();
  await expect(page.getByTestId("impact-delivery")).toHaveCount(0);
  await page.screenshot({ path: shot("02-select-is-current"), fullPage: true });

  // The call to action opens the slice comparison and moves focus into it. It selects nothing.
  expect(await pressGuideButton(page)).toEqual([]);
  const drawer = page.getByTestId("slice-drawer");
  await expect(drawer).toBeFocused();
  await expect(drawer).toContainText("No slice is selected");
  expect(await workStateExists()).toBe(false);
  await expect(guide).toHaveAttribute("data-current-step", "select");

  await page.getByLabel("Selector name").fill(HUMAN);
  await page.getByTestId("select-slice-outcome-thread").click();
  await expect(page.getByTestId("selection-record")).toBeVisible();
  await page.getByTestId("slices-close").click();
  await expect(guide).toHaveAttribute("data-current-step", "complete");
  await expect(page.getByTestId("guide-progress")).toHaveText("6 of 6 steps done");
  await expect(page.getByTestId("impact-delivery")).toBeVisible();
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(200);
  await page.screenshot({ path: shot("03-all-steps-done"), fullPage: true });

  // A change to the map: the guide goes back to approval and shows the earlier selection as stale.
  const card = page.getByTestId("card-step-export-work");
  await card.getByRole("button", { name: /^Edit/ }).click();
  await card.locator("textarea[name='description']").fill("Changed after the slice was selected.");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(guide).toHaveAttribute("data-current-step", "approve");
  await expect(page.getByTestId("guide-stale-select")).toBeVisible();
  await expect(page.getByTestId("guide-stale-note")).toContainText("nothing was deleted or chosen for you");
  await expect(page.getByTestId("impact-delivery")).toHaveCount(0);
  expect(await workStateExists()).toBe(true);
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(409);
  await page.screenshot({ path: shot("04-back-at-approval-selection-stale"), fullPage: true });
});

test("the guide can be hidden and shown; the expert UI works without it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("guide")).toBeVisible();
  await page.getByTestId("guide-hide").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("guide")).toHaveCount(0);
  await expect(page.getByTestId("guide-show")).toBeFocused();

  // Hidden stays hidden after a reload, and the map can still be approved the expert way.
  await page.reload();
  await expect(page.getByTestId("guide-show")).toBeVisible();
  await expect(page.getByTestId("guide")).toHaveCount(0);
  await page.getByLabel("Approver name").fill(HUMAN);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await page.getByTestId("slices-open").click();
  await expect(page.getByTestId("slice-comparison")).toBeVisible();
  await page.getByTestId("slices-close").click();
  await page.screenshot({ path: shot("05-guide-hidden-expert-ui"), fullPage: true });

  // Shown again, it reads the same state: approval is done, selecting is current.
  const beforeShow = await storedText();
  await page.getByTestId("guide-show").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "select");
  await expect(page.getByTestId("guide-cta")).toBeFocused();
  await page.getByTestId("guide-hide").click();
  await expect(page.getByTestId("guide")).toHaveCount(0);
  // Hiding or showing the guide writes neither the product nor the work state.
  expect(await storedText()).toBe(beforeShow);
  expect(await workStateExists()).toBe(false);
});

test("a map with nobody's needs on it: the guide points at the input, not at approval", async ({ page }) => {
  // The fixture with every need removed, and every reference to one.
  const doc = YAML.parse(await storedText());
  const gone = new Set(doc.needs.map((n: { id: string }) => n.id));
  doc.needs = [];
  for (const step of doc.narrative) step.needIds = [];
  doc.decisions = doc.decisions
    .map((d: { relatesTo: string[] }) => ({ ...d, relatesTo: d.relatesTo.filter((id) => !gone.has(id)) }))
    .filter((d: { relatesTo: string[] }) => d.relatesTo.length > 0);
  await fs.writeFile(E2E_PRODUCT_FILE, YAML.stringify(doc));
  const before = await storedText();

  await page.goto("/");
  await expect(page.getByTestId("load-error")).toHaveCount(0);
  const guide = page.getByTestId("guide");
  await expect(guide).toHaveAttribute("data-current-step", "people");
  await expect(page.getByTestId("guide-progress")).toHaveText("1 of 6 steps done");
  await expect(page.getByTestId("impact-map")).toHaveCount(0);
  expect(await pressGuideButton(page)).toEqual([]);
  await expect(page.getByTestId("transcript-input")).toBeFocused();
  expect(await storedText()).toBe(before);
  await page.screenshot({ path: shot("07-people-step-is-current"), fullPage: true });
});

test("an open proposal comes first, and the guide leaves the decision to the human", async ({ page }) => {
  await page.goto("/");
  const before = await storedText();
  await page.getByTestId("transcript-input").fill(await fs.readFile(path.join(__dirname, "..", "fixtures", "workshop-transcript.txt"), "utf8"));
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await expect(page.getByTestId("guide-cta")).toHaveText("Decide on the open proposal");
  expect(await pressGuideButton(page)).toEqual([]);
  await expect(page.getByTestId("proposal-review")).toBeFocused();
  expect(await storedText()).toBe(before);
  await page.screenshot({ path: shot("06-open-proposal-first"), fullPage: true });
});

test("a hidden guide is not painted while the page loads", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("guide-hide").click();
  await expect(page.getByTestId("guide")).toHaveCount(0);

  // Hold the scripts back: what is visible now is the server's HTML before React takes over.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/_next/static/**/*.js", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.getByTestId("product-name")).toBeVisible();
  // The server always renders the panel; the stored preference hides it before the first paint.
  await expect(page.getByTestId("guide")).toHaveCount(1);
  await expect(page.getByTestId("guide")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-guide", "off");
  await expect(page.getByTestId("guide-show")).toHaveCount(0);

  release();
  await expect(page.getByTestId("guide-show")).toBeVisible();
  await expect(page.getByTestId("guide")).toHaveCount(0);

  // Shown again: the attribute is gone, and a reload paints the guide from the start.
  await page.unroute("**/_next/static/**/*.js");
  await page.getByTestId("guide-show").click();
  await expect(page.getByTestId("guide")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-guide", "off");
});
