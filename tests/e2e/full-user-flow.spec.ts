import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";
import { EXAMPLES, SCREENSHOTS } from "./artifacts";

/**
 * ASM-28: the full user flow, in one run, on an isolated workspace.
 *
 *   fresh start -> tutorial -> pasted text + a file -> grouped proposal ->
 *   choose, edit, reject, accept -> first map -> product flow -> review / WCBC
 *   -> approval -> people check -> slice candidates -> selection -> work order
 *   JSON + Markdown read back and bound -> start over -> fresh start -> again.
 *
 * The deterministic provider reads marker lines, so the file carries them and
 * the pasted text is prose; a real model on the same screens is the live smoke
 * (`npm run smoke:live`). Its screenshots are the gallery docs/full-user-flow.md.
 */
const LEAD = "Maya (Product Lead)";
const NAME = "Parcel lockers";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const exists = (file: string) => fs.access(file).then(() => true, () => false);
const shot = (name: string) => path.join(SCREENSHOTS, `fuf-${name}.png`);
const stored = async () => YAML.parse(await fs.readFile(E2E_PRODUCT_FILE, "utf8"));

const PASTED = [
  "Kick-off for the parcel lockers in the Lindenhof building.",
  "Residents miss parcels because couriers come while people are at work; the packages end up at a shop two streets away.",
  "Maya: the point is that a resident can collect a parcel whenever they come home, without waiting for anyone.",
  "Do oversized parcels go somewhere else?",
  "Who pays for a damaged locker?",
].join("\n");

const NOTES_MD = [
  "# Structured notes from the kick-off",
  "Goal: Residents collect a parcel without waiting for a courier.",
  "Goal: Couriers deliver to the whole building in one stop.",
  "Persona: Resident — Lives in the building and comes home late. [roles: customer, user]",
  "Persona: Courier — Delivers for three carriers. [roles: operator]",
  "Actor: Building manager — Owns the lobby and handles complaints. [roles: stakeholder]",
  "Need (Resident): Get my parcel on the day it arrives.",
  "Need (Resident): Know when something has arrived.",
  "Need (Courier): Drop a parcel in under a minute.",
  "Step: Courier scans the parcel — A free compartment opens. [personas: Courier] [needs: Drop a parcel in under a minute]",
  "Step: Courier closes the compartment — The parcel is logged. [personas: Courier]",
  "Step: Resident gets a notification — With a code. [personas: Resident] [needs: Know when something has arrived]",
  "Step: Resident opens the compartment — Enters the code at the locker. [personas: Resident] [needs: Get my parcel on the day it arrives]",
  "Step: Resident takes the parcel — The compartment is free again. [personas: Resident] [needs: Get my parcel on the day it arrives]",
].join("\n");

/** Every control has a name a screen reader can say; every button has text. */
async function expectAccessible(page: Page, where: string) {
  const unnamed = await page.locator("button, input:not([type='hidden']), select, textarea").evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const el = node as HTMLElement;
        if (el.hidden || el.closest("[hidden]")) return false;
        const name = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (el.id && document.querySelector(`label[for='${el.id}']`)?.textContent) || el.closest("label")?.textContent || el.textContent;
        return !name || name.trim() === "";
      })
      .map((node) => (node as HTMLElement).outerHTML.slice(0, 80)),
  );
  expect(unnamed, `${where}: unnamed controls`).toEqual([]);
}

test.describe.configure({ mode: "serial" });

test("a first-time Product Lead: tutorial, context, proposal, map, review, approval, people, slices, work order, start over, again", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1400 });
  await fs.rm(E2E_PRODUCT_FILE, { force: true });
  await fs.rm(E2E_WORK_STATE_FILE, { force: true });
  await fs.mkdir(EXAMPLES, { recursive: true });

  // 1-2. Fresh: the start screen with the tutorial at its first step and the product flow at its first step.
  await page.goto("/");
  await expect(page.getByTestId("start-screen")).toBeVisible();
  await expect(page.getByTestId("tutorial")).toHaveAttribute("data-step", "1");
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "intent");
  await expectAccessible(page, "fresh start");
  await page.screenshot({ path: shot("01-fresh-start-with-tutorial"), fullPage: true });
  for (let i = 0; i < 3; i++) await page.getByTestId("tutorial-next").click();
  await expect(page.getByTestId("tutorial")).toHaveAttribute("data-step", "4");
  await page.screenshot({ path: shot("02-tutorial-last-step"), fullPage: true });
  await page.getByTestId("tutorial-finish").click();
  await expect(page.getByTestId("tutorial")).toHaveCount(0);
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "intent");

  // 3-4. Ordinary text plus a markdown file: two sources, listed.
  await page.getByTestId("product-name-input").fill(NAME);
  await page.getByTestId("transcript-input").fill(PASTED);
  await page.getByTestId("context-files").setInputFiles([{ name: "kickoff-notes.md", mimeType: "text/markdown", buffer: Buffer.from(NOTES_MD, "utf8") }]);
  await expect(page.getByTestId("context-source-src-2")).toContainText("kickoff-notes.md");
  await page.screenshot({ path: shot("03-context-bundle"), fullPage: true });
  expect(await exists(E2E_PRODUCT_FILE)).toBe(false);

  // 5-6. The proposal, grouped: goal as a choice, people, needs, path, questions from both sources.
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  for (const group of ["goal", "personas", "actors", "needs", "path", "questions"]) await expect(page.getByTestId(`proposal-section-${group}`)).toBeVisible();
  await expect(page.locator("input[name='goal-choice']")).toHaveCount(2);
  await expect(page.locator("input[name='goal-choice']:checked")).toHaveCount(0);
  await expect(page.getByTestId("proposal-section-questions").locator("[data-testid^='diff-op-']")).toHaveCount(2);
  await expect(page.getByTestId("proposal-section-questions")).toContainText("Pasted text");
  await expect(page.getByTestId("proposal-section-personas")).toContainText("kickoff-notes.md");
  await expect(page.getByTestId("proposal-accept")).toBeDisabled();
  await expectAccessible(page, "proposal");
  await page.screenshot({ path: shot("04-grouped-proposal"), fullPage: true });

  // 7-9. Decide: the first goal; one need reworded with its chip and then by hand; one step rejected; the rest used.
  await page.getByLabel("Choose op-1", { exact: true }).check();
  await expect(page.getByTestId("preview-goal")).toHaveText("Residents collect a parcel without waiting for a courier.");
  const needOp = await page.getByTestId("proposal-section-needs").locator("[data-testid^='diff-op-']").first().getAttribute("data-testid");
  const needId = needOp!.replace("diff-", "");
  await page.getByTestId(`edit-${needId}`).click();
  await page.getByTestId(`chip-${needId}-statement-0`).click();
  await page.locator(`textarea[name='${needId}-statement']`).fill("Get my parcel on the day it arrives, even late at night.");
  await page.getByTestId(`edit-${needId}`).click();
  const stepOp = await page.getByTestId("proposal-section-path").locator("[data-testid^='diff-op-']").nth(1).getAttribute("data-testid");
  const stepId = stepOp!.replace("diff-", "");
  await page.getByLabel(`Include ${stepId}`, { exact: true }).uncheck();
  await expect(page.getByTestId(stepOp!)).toHaveAttribute("data-state", "rejected");
  await expect(page.getByTestId("preview-path").locator("li")).toHaveCount(4);
  await page.screenshot({ path: shot("05-proposal-chosen-edited-rejected"), fullPage: true });
  expect(await exists(E2E_PRODUCT_FILE)).toBe(false);

  // 10. Accept: the first map, proposed revision 1; the product flow moves on from the real state.
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("product-name")).toHaveText(NAME);
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByTestId("story-map").locator("[data-kind='step']")).toHaveCount(4);
  await expect(page.getByTestId("open-decisions")).toHaveText("2 open");
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "approve");
  const revision1 = await stored();
  expect(revision1.revision).toEqual({ number: 1, status: "proposed" });
  expect(revision1.goal.statement).toBe("Residents collect a parcel without waiting for a courier.");
  expect(revision1.needs.map((n: { statement: string }) => n.statement)).toContain("Get my parcel on the day it arrives, even late at night.");
  expect(new Set(revision1.provenance.map((p: { sourceLabel: string }) => p.sourceLabel))).toEqual(new Set(["Pasted text", "kickoff-notes.md"]));
  await expectAccessible(page, "map");
  await page.screenshot({ path: shot("06-first-map"), fullPage: true });
  await page.getByTestId("guide").screenshot({ path: shot("07-product-flow") });

  // 11. Review and WCBC: fixed checks and the agent review; one worst case accepted opens revision 2.
  await page.getByTestId("guide-cta").click();
  await expect(page.getByTestId("review-panel")).toBeVisible();
  await page.getByTestId("agent-review-button").click();
  const suggestions = page.getByTestId("wcbc-suggestions").locator("[data-testid^='agent-finding-']");
  await expect(suggestions.first()).toBeVisible();
  await expect(page.getByTestId("review-panel").locator("input[type='checkbox']:checked")).toHaveCount(0);
  await page.screenshot({ path: shot("08-review-and-wcbc"), fullPage: true });
  await page.getByLabel("Accept af-1", { exact: true }).check();
  await page.getByTestId("review-accept").click();
  await expect(page.getByTestId("review-status")).toContainText("proposed revision 2");
  await expect(page.getByTestId("story-map").locator("[data-kind='wcbc']")).toHaveCount(1);

  // 12. Approval, by a named human.
  await page.getByLabel("Approver name").fill(LEAD);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "people_check");
  await page.screenshot({ path: shot("09-approved"), fullPage: true });

  // 13. People check; the server gate is proven, not only the button.
  await page.getByTestId("guide-cta").click();
  const drawer = page.getByTestId("slice-drawer");
  const selectButton = page.locator("[data-testid^='select-slice-']").first();
  await expect(selectButton).toBeDisabled();
  const candidateId = (await selectButton.getAttribute("data-testid"))!.replace("select-", "");
  const live0 = await (await page.request.get("/api/slices")).json();
  const early = await page.request.post("/api/slices/select", { data: { candidateId, selectedBy: LEAD, mapFingerprint: live0.mapFingerprint } });
  expect(early.status()).toBe(409);
  await page.getByLabel("Confirmed by").fill(LEAD);
  await page.getByTestId("people-check-confirm").click();
  await expect(page.getByTestId("people-check-record")).toContainText(LEAD);

  // 14-15. Candidates compared (reads choose nothing), then one selected by a named human.
  expect(await page.locator("[data-testid^='candidate-slice-']").count()).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < 2; i++) expect((await (await page.request.get("/api/slices")).json()).selection).toBeNull();
  await drawer.screenshot({ path: shot("10-slice-candidates") });
  await page.getByLabel("Selector name").fill(LEAD);
  await selectButton.click();
  await expect(page.getByTestId("selection-record")).toContainText(LEAD);
  await expect(page.getByTestId("value-status")).toHaveAttribute("data-value", "VALUE_RESOLVED");
  await drawer.screenshot({ path: shot("11-slice-selected-work-order-ready") });
  await expectAccessible(page, "slice drawer");

  // 16-18. Work order as JSON and Markdown, read back and bound to this exact map and selection.
  const live = await (await page.request.get("/api/slices")).json();
  const json = await page.request.get("/api/brief?format=json");
  expect(json.status()).toBe(200);
  const brief = await json.json();
  expect(brief.kind).toBe("asm.execution-brief");
  expect(brief.sourceMapRevision).toMatchObject({ productId: "parcel-lockers", revision: 2, status: "approved", approvedBy: LEAD, mapFingerprint: live.mapFingerprint });
  expect(brief.approvedContext.selection).toMatchObject({ candidateId, selectedBy: LEAD, candidateFingerprint: live.selection.candidateFingerprint, derivationVersion: live.derivationVersion });
  expect(brief.approvedContext.peopleConsidered).toMatchObject({ confirmedBy: LEAD });
  const markdown = await (await page.request.get("/api/brief?format=md")).text();
  expect(markdown).toContain(`Map fingerprint: \`${live.mapFingerprint}\``);
  expect(markdown).toContain(`- Approved: revision 2 by ${LEAD}`);
  await fs.writeFile(path.join(EXAMPLES, "full-user-flow.work-order.json"), await json.text());
  await fs.writeFile(path.join(EXAMPLES, "full-user-flow.work-order.md"), markdown);
  await page.getByTestId("slices-close").click();
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "complete");

  // 19-21. Start over: asked, confirmed, and the fresh start screen without a restart.
  await page.getByTestId("start-over").click();
  await expect(page.getByRole("dialog", { name: "Start over?" })).toBeVisible();
  await page.screenshot({ path: shot("12-start-over-confirmation"), fullPage: true });
  await page.getByTestId("start-over-confirm").click();
  await expect(page.getByTestId("start-screen")).toBeVisible();
  expect(await exists(E2E_PRODUCT_FILE)).toBe(false);
  expect(await exists(E2E_WORK_STATE_FILE)).toBe(false);
  // The tutorial was seen in this browser: not shown again; the product flow is at its first step.
  await expect(page.getByTestId("tutorial")).toHaveCount(0);
  await expect(page.getByTestId("tutorial-replay")).toBeVisible();
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "intent");
  await page.screenshot({ path: shot("13-fresh-after-start-over"), fullPage: true });

  // 22. Nothing old is effective: every read answers no_product, the old brief is gone.
  for (const url of ["/api/product", "/api/slices", "/api/brief?format=json", "/api/brief?format=md"]) {
    const response = await page.request.get(url);
    expect(response.status(), url).toBe(404);
  }

  // 23. Again, at once, in the same server: a basic start, and the old people check, selection and value are not there.
  await page.getByTestId("product-name-input").fill("Second product");
  await page.getByTestId("transcript-input").fill(["Goal: Something small.", "Persona: Someone — Uses it. [roles: user]", "Need (Someone): A thing.", "Step: Someone does the thing — Quickly. [personas: Someone] [needs: A thing]"].join("\n"));
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("product-name")).toHaveText("Second product");
  await expect(page.getByTestId("selected-slice-badge")).toHaveCount(0);
  await expect(page.getByTestId("stale-slice-badge")).toHaveCount(0);
  await expect(page.getByTestId("stale-people-check-badge")).toHaveCount(0);
  const second = await (await page.request.get("/api/slices")).json();
  expect(second.selection).toBeNull();
  expect(second.mapFingerprint).not.toBe(live.mapFingerprint);
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(409);
  expect(await exists(E2E_WORK_STATE_FILE)).toBe(false);
  expect(sha(await fs.readFile(E2E_PRODUCT_FILE, "utf8"))).not.toBe(sha(YAML.stringify(revision1)));
  await page.screenshot({ path: shot("14-second-product-fresh"), fullPage: true });
});
