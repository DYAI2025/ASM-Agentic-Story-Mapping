import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";
import { EXAMPLES, SCREENSHOTS } from "./artifacts";

/**
 * The whole first-time-user path, in the order the prototype contract names
 * it, in one browser session and with the deterministic provider:
 *
 *   product intent -> people and needs -> main path -> proposal review
 *   -> findings and WCBC -> approval -> who else matters -> slice candidates
 *   -> selection -> work order; then a change of meaning and the way back.
 *
 * Nothing exists on disk when it starts. Every state is captured as a
 * screenshot under docs/screenshots (through npm run docs:refresh).
 */

const LEAD = "Noor (first-time Product Lead)";
const NAME = "Parcel Locker Pickup";
const INTENT = [
  "We run parcel lockers in apartment buildings and people keep missing deliveries.",
  "Goal: Residents collect a parcel from the building locker without waiting for a courier.",
  "Persona: Resident — Lives in the building and orders online. [roles: customer, user]",
  "Persona: Courier — Delivers parcels to the building. [roles: operator]",
  "Actor: Building manager — Owns the lobby where the locker stands. [roles: stakeholder]",
  "Need (Resident): Get my parcel on the day it arrives, whenever I come home.",
  "Need (Courier): Hand over every parcel in one stop.",
  "Step: Courier loads the locker — One compartment per parcel. [personas: Courier] [needs: Hand over every parcel in one stop.]",
  "Step: Resident is told the parcel is there — A code arrives on the phone. [personas: Resident] [needs: Get my parcel on the day it arrives]",
  "Step: Resident opens the compartment — With the code, at any hour. [personas: Resident] [needs: Get my parcel on the day it arrives]",
  "Step: Resident reports a problem — When the compartment will not open, the courier comes back. [personas: Resident, Courier] [needs: Get my parcel on the day it arrives; Hand over every parcel in one stop]",
  "Who pays for the locker?",
].join("\n");

const shot = (name: string) => path.join(SCREENSHOTS, `first-time-${name}.png`);
const exists = () => fs.access(E2E_PRODUCT_FILE).then(() => true, () => false);
const stored = async () => YAML.parse(await fs.readFile(E2E_PRODUCT_FILE, "utf8"));
/** The stored work state; no file yet means nothing has been confirmed or selected. */
const workState = async () => fs.readFile(E2E_WORK_STATE_FILE, "utf8").then((text) => JSON.parse(text), () => ({}));

/**
 * Every control on the page has a name a screen reader would say, and every
 * button and link says something. The name is computed the way the
 * accessible-name algorithm does for the cases this UI uses: aria-label,
 * aria-labelledby, a label (by `for` or as the label's own control — a label
 * names only its first labelable descendant), the visible text without parts
 * hidden from assistive technology, title. A placeholder is not a name.
 */
async function expectAccessible(page: Page, where: string) {
  const unnamed = await page.evaluate(() => {
    const visible = (el: HTMLElement) => !el.hidden && el.getClientRects().length > 0;
    const controls = [...document.querySelectorAll<HTMLElement>("input:not([type=hidden]), textarea, select, button, a[href], [role='button']")].filter(visible);
    const visibleText = (node: Element): string =>
      node.getAttribute("aria-hidden") === "true"
        ? ""
        : [...node.childNodes].map((child) => (child.nodeType === Node.TEXT_NODE ? child.textContent ?? "" : child instanceof Element ? visibleText(child) : "")).join("");
    const nameOf = (el: HTMLElement) => {
      const byAria = el.getAttribute("aria-label");
      if (byAria?.trim()) return byAria;
      const byIds = el.getAttribute("aria-labelledby");
      if (byIds) return byIds.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      const forLabel = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      if (forLabel?.textContent?.trim()) return forLabel.textContent;
      const wrapping = el.closest("label");
      if (wrapping && (wrapping as HTMLLabelElement).control === el && wrapping.textContent?.trim()) return wrapping.textContent;
      if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.title;
      return visibleText(el).trim() || el.title;
    };
    return controls.filter((el) => nameOf(el).trim() === "").map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className ? `.${String(el.className).split(" ")[0]}` : ""}`);
  });
  expect(unnamed, `${where}: controls without an accessible name`).toEqual([]);
  expect(await page.locator("h1, h2").count(), `${where}: headings`).toBeGreaterThan(0);
}

test.describe.configure({ mode: "serial" });

test("a first-time Product Lead goes from own words to a work order, then changes the map and finds the way back", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 1400 });
  await fs.rm(E2E_PRODUCT_FILE, { force: true });
  await fs.rm(E2E_WORK_STATE_FILE, { force: true });

  // 1. Product intent: nothing exists yet; the guide starts at its first step without any ASM term.
  await page.goto("/");
  await expect(page.getByTestId("start-screen")).toBeVisible();
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "intent");
  await expectAccessible(page, "start screen");
  await page.screenshot({ path: shot("01-product-intent"), fullPage: true });

  // 2 + 3. People, needs and the ideal path, in the user's own words; the proposal is previewed, nothing is saved.
  await page.getByTestId("product-name-input").fill(NAME);
  await page.getByTestId("transcript-input").fill(INTENT);
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await expect(page.getByTestId("preview-path").locator("li")).toHaveCount(4);
  await expect(page.getByTestId("preview-people").locator("> li")).toHaveCount(3);
  expect(await exists()).toBe(false);
  await page.screenshot({ path: shot("02-proposal-and-map-preview"), fullPage: true });

  // 4. Human review: the user drops the open question (op 11), then accepts the rest. Revision 1 exists now, proposed.
  await page.getByLabel("Include op-11").uncheck();
  await expect(page.getByTestId("proposal-accept")).toHaveText("Accept 10 changes");
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("product-name")).toHaveText(NAME);
  await expect(page.getByText("Revision 1", { exact: true })).toBeVisible();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByTestId("story-map").locator("[data-kind='step']")).toHaveCount(4);
  await expect(page.getByTestId("open-decisions")).toHaveText("0 open");
  await expect(page.getByTestId("impact-map")).toBeVisible();
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "approve");
  await expectAccessible(page, "map");
  const revision1 = await stored();
  expect(revision1.revision).toEqual({ number: 1, status: "proposed" });
  await page.screenshot({ path: shot("03-first-map"), fullPage: true });

  // 5. Findings and WCBC: fixed checks and the agent review propose; the user accepts one worst case, which opens revision 2.
  await page.getByTestId("guide-cta").click();
  await expect(page.getByTestId("review-panel")).toBeVisible();
  await expect(page.getByTestId("deterministic-findings")).toContainText("The fixed checks found nothing.");
  await page.getByTestId("agent-review-button").click();
  const suggestions = page.getByTestId("wcbc-suggestions").locator("[data-testid^='agent-finding-']");
  await expect(suggestions).toHaveCount(4);
  await expect(page.getByTestId("review-panel").locator("input[type='checkbox']:checked")).toHaveCount(0);
  await expectAccessible(page, "review panel");
  await page.screenshot({ path: shot("04-findings-and-wcbc-suggestions"), fullPage: true });
  await page.getByLabel("Accept af-1", { exact: true }).check();
  await page.getByTestId("review-accept").click();
  await expect(page.getByTestId("review-status")).toContainText("proposed revision 2");
  await expect(page.getByTestId("story-map").locator("[data-kind='wcbc']")).toHaveCount(1);
  expect((await stored()).revision).toEqual({ number: 2, status: "proposed" });

  // 6. Approval, by a named human, in the existing form. The guide moves on only then.
  await page.getByLabel("Approver name").fill(LEAD);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await expect(page.getByTestId("approval-record")).toContainText(LEAD);
  // The review panel's "needs approval again" line described revision 2 proposed; it is gone once that is no longer so.
  await expect(page.getByTestId("review-status")).toHaveCount(0);
  await expect(page.getByTestId("impact-sensemaking")).toContainText(LEAD);
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "people_check");
  await page.screenshot({ path: shot("05-approved"), fullPage: true });

  // 7. Who else matters: the user confirms, with a name. ASM claims nothing about completeness.
  await page.getByTestId("guide-cta").click();
  const drawer = page.getByTestId("slice-drawer");
  await expect(drawer).toBeFocused();
  await expect(page.getByTestId("people-check-list").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("people-check")).toContainText("ASM cannot know");
  await expect(page.getByTestId("select-slice-outcome-thread")).toBeDisabled();
  // The gate is the server's, not the button's: selecting without the check is refused and writes nothing.
  const early = await page.request.post("/api/slices/select", { data: { candidateId: "slice-outcome-thread", selectedBy: LEAD, mapFingerprint: (await (await page.request.get("/api/slices")).json()).mapFingerprint } });
  expect(early.status()).toBe(409);
  expect((await early.json()).issues[0].code).toBe("selection_rejected");
  expect((await workState()).selection).toBeUndefined();
  await expectAccessible(page, "slice drawer before the people check");
  await page.getByTestId("people-check").screenshot({ path: shot("06-who-else-matters") });
  await page.getByLabel("Confirmed by").fill(LEAD);
  await page.getByTestId("people-check-confirm").click();
  await expect(page.getByTestId("people-check-record")).toContainText(LEAD);
  expect((await workState()).selection).toBeUndefined();

  // 8. Candidates compared: two or three, explained from the map, none chosen — not by a read, however often.
  await expect(page.locator("[data-testid^='candidate-slice-']")).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const read = await (await page.request.get("/api/slices")).json();
    expect(read.selection, `read ${i + 1}`).toBeNull();
    expect(read.candidates.length, `read ${i + 1}`).toBe(3);
  }
  expect((await workState()).selection).toBeUndefined();
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(409);
  await expect(drawer).toContainText("The order is not a ranking and there is no score");
  await expect(drawer).toContainText("No slice is selected");
  await drawer.screenshot({ path: shot("07-slice-candidates") });

  // 9. Selection, by a named human.
  await page.getByLabel("Selector name").fill(LEAD);
  await page.getByTestId("select-slice-outcome-thread").click();
  await expect(page.getByTestId("selection-record")).toContainText(LEAD);
  await expect(page.getByTestId("value-status")).toHaveAttribute("data-value", "VALUE_RESOLVED");
  await drawer.screenshot({ path: shot("08-slice-selected") });
  await page.getByTestId("slices-close").click();
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "complete");
  await expect(page.getByTestId("guide-progress")).toHaveText("7 of 7 steps done");
  await expect(page.getByTestId("impact-delivery")).toBeVisible();
  await page.screenshot({ path: shot("09-all-steps-done"), fullPage: true });

  // 10. Work order: exported as JSON and Markdown, read back, bound to the exact map and selection.
  const live = await (await page.request.get("/api/slices")).json();
  await page.getByTestId("slices-open").click();
  const jsonHref = await page.getByTestId("export-work-order-json").getAttribute("href");
  const mdHref = await page.getByTestId("export-work-order-md").getAttribute("href");
  expect(jsonHref).toBe("/api/brief?format=json");
  expect(mdHref).toBe("/api/brief?format=md");
  await page.getByTestId("slices-close").click();
  const json = await page.request.get(jsonHref!);
  expect(json.status()).toBe(200);
  const brief = await json.json();
  expect(brief.briefVersion).toBe(3);
  expect(brief.kind).toBe("asm.execution-brief");
  expect(brief.sourceMapRevision).toMatchObject({ productId: "parcel-locker-pickup", revision: 2, status: "approved", approvedBy: LEAD, mapFingerprint: live.mapFingerprint });
  expect(brief.approvedContext.selection).toMatchObject({ candidateId: "slice-outcome-thread", selectedBy: LEAD, candidateFingerprint: live.selection.candidateFingerprint, derivationVersion: live.derivationVersion });
  expect(brief.approvedContext.peopleConsidered).toMatchObject({ confirmedBy: LEAD });
  expect(brief.approvedContext.value.status).toBe("VALUE_RESOLVED");
  expect(brief.inScope.length).toBeGreaterThan(0);
  expect(brief.personas.map((e: { id: string }) => e.id)).toContain("persona-resident");
  const markdown = await (await page.request.get(mdHref!)).text();
  expect(markdown).toContain("Work order contract: `asm.execution-brief`, briefVersion 3.");
  expect(markdown).toContain(`- Approved: revision 2 by ${LEAD}`);
  expect(markdown).toContain(`- Who else matters: considered by ${LEAD}`);
  expect(markdown).toContain(`Map fingerprint: \`${live.mapFingerprint}\``);
  await fs.mkdir(EXAMPLES, { recursive: true });
  await fs.writeFile(path.join(EXAMPLES, "first-time.work-order.json"), await json.text());
  await fs.writeFile(path.join(EXAMPLES, "first-time.work-order.md"), markdown);

  // 11. A change of meaning: everything built on the old meaning is stale, explained, and the way back is shown.
  const goal = page.getByTestId(`card-${revision1.goal.id}`);
  await goal.getByRole("button", { name: /^Edit/ }).click();
  await goal.locator("textarea[name='statement']").fill("Residents and couriers never miss each other again.");
  await goal.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "approve");
  await expect(page.getByTestId("stale-summary")).toContainText("The way back starts at “Check the story and approve it”");
  await expect(page.getByTestId("stale-slice-badge")).toBeVisible();
  await expect(page.getByTestId("stale-people-check-badge")).toBeVisible();
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(409);
  await page.screenshot({ path: shot("10-stale-after-a-change"), fullPage: true });

  // 12. The way back: approve, confirm, pick again; a new work order bound to the new map.
  await page.getByLabel("Approver name").fill(LEAD);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await page.getByTestId("slices-open").click();
  await page.getByTestId("reselect-candidates").click();
  await expect(page.getByLabel("Confirmed by")).toBeFocused();
  await page.keyboard.type(LEAD);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("people-check-record")).toBeVisible();
  await page.getByTestId("reselect-candidates").click();
  await expect(page.getByLabel("Selector name")).toBeFocused();
  await page.keyboard.type(LEAD);
  await page.getByTestId("select-slice-outcome-thread").click();
  await expect(page.getByTestId("selection-record")).toBeVisible();
  await page.getByTestId("slices-close").click();
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "complete");
  const again = await (await page.request.get("/api/brief?format=json")).json();
  expect(again.sourceMapRevision.revision).toBe(3);
  expect(again.sourceMapRevision.mapFingerprint).not.toBe(live.mapFingerprint);

  // 13. The map's meaning is what the approval and the work order are bound to, not the revision number:
  // the same revision and approval with one changed need is refused, and the stored file is untouched.
  const approvedDoc = await stored();
  const approvedBytes = await fs.readFile(E2E_PRODUCT_FILE, "utf8");
  const tampered = structuredClone(approvedDoc);
  tampered.needs[0].statement = "Changed under the same approval.";
  const put = await page.request.put("/api/product", { data: YAML.stringify(tampered) });
  expect(put.status()).toBe(409);
  expect((await put.json()).issues[0].code).toBe("approved_content_changed");
  expect(await fs.readFile(E2E_PRODUCT_FILE, "utf8")).toBe(approvedBytes);
  expect(again.sourceMapRevision.mapFingerprint).toBe((await (await page.request.get("/api/slices")).json()).mapFingerprint);
  await page.screenshot({ path: shot("11-way-back-complete"), fullPage: true });
});
