import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE } from "../../playwright.config";
import { resetProductFile } from "./global-setup";

const TRANSCRIPT_FILE = path.join(__dirname, "..", "fixtures", "workshop-transcript.txt");
const SCREENSHOTS = path.join(__dirname, "..", "..", "docs", "screenshots");
const EXAMPLES = path.join(__dirname, "..", "..", "docs", "examples");
const HUMAN = "Maya (E2E)";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetProductFile);

const storedText = () => fs.readFile(E2E_PRODUCT_FILE, "utf8");
const stored = async () => YAML.parse(await storedText());
const shot = (name: string) => path.join(SCREENSHOTS, `loop-${name}.png`);

test("transcript -> map proposal -> approve -> review -> slice candidates -> select -> export", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 2800, height: 1400 });

  // 1. Transcript -> map proposal -> a human accepts it.
  await page.goto("/");
  await page.getByTestId("transcript-input").fill(await fs.readFile(TRANSCRIPT_FILE, "utf8"));
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await page.screenshot({ path: shot("01-map-proposal"), fullPage: true });
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByText("Revision 2", { exact: true })).toBeVisible();

  // 2. A human approves the narrative.
  await page.getByLabel("Approver name").fill(HUMAN);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await page.screenshot({ path: shot("02-approved"), fullPage: true });

  // 3. Review mode: the findings inbox, from fixed checks.
  await page.getByTestId("review-toggle").click();
  const inbox = page.getByTestId("deterministic-findings");
  await expect(inbox.locator("[data-code='wcbc_without_outcome']")).toHaveCount(6);
  await expect(page.getByTestId("finding-behavior_without_need:step-walk-through-the-slice-with-the-team")).toBeVisible();
  await expect(inbox.locator("[data-code='orphan_need']")).toContainText("Trace a customer problem back");
  await expect(page.getByTestId("finding-flag-step-walk-through-the-slice-with-the-team")).toHaveText("1 finding");
  await page.screenshot({ path: shot("03-findings-inbox"), fullPage: true });

  // 4. Agent review: findings and WCBC suggestions appear, and nothing is written.
  const beforeReview = await storedText();
  await page.getByTestId("agent-review-button").click();
  const suggestions = page.getByTestId("wcbc-suggestions").locator("[data-testid^='agent-finding-']");
  await expect(suggestions).toHaveCount(6);
  await expect(page.getByTestId("wcbc-suggestions").locator("[data-origin='NEW_PROPOSAL']")).toHaveCount(6);
  await expect(page.getByTestId("agent-findings").locator("[data-kind='missing_transition']")).toHaveAttribute("data-origin", "existing");
  await expect(page.getByTestId("review-panel").locator("input[type='checkbox']:checked")).toHaveCount(0);
  await expect(page.getByTestId("review-accept")).toBeDisabled();
  expect(await storedText()).toBe(beforeReview);
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await page.getByTestId("review-panel").screenshot({ path: shot("04-agent-findings-and-wcbc-suggestions") });

  // 5. A human accepts one WCBC suggestion. Only that one lands, as a new proposed revision.
  await page.getByLabel("Accept af-1", { exact: true }).check();
  await page.getByTestId("review-accept").click();
  await expect(page.getByTestId("review-status")).toContainText("proposed revision 3");
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByTestId("card-wcbc-start-product-cannot-be-completed")).toBeVisible();
  expect((await stored()).wcbc).toHaveLength(9);

  // A human closes a gap found by the fixed checks: where does this worst case lead?
  const gap = page.getByTestId("finding-wcbc_without_outcome:wcbc-no-small-slice");
  await gap.getByLabel("Outcome target for wcbc-no-small-slice").selectOption("step-main-path");
  await page.getByTestId("outcome-save-wcbc-no-small-slice").click();
  await expect(page.getByTestId("outcome-wcbc-no-small-slice")).toContainText("step-main-path");
  await expect(gap).toHaveCount(0);
  await page.screenshot({ path: shot("05-finding-accepted-revision-proposed"), fullPage: true });

  // 6. Slice candidates exist, but nothing can be selected or exported on a proposed revision.
  await page.getByTestId("slices-open").click();
  await expect(page.getByTestId("slice-needs-approval")).toBeVisible();
  await expect(page.locator("[data-testid^='candidate-slice-']")).toHaveCount(3);
  await expect(page.getByTestId("select-slice-outcome-thread")).toBeDisabled();
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(409);
  await page.getByTestId("slices-close").click();

  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");

  // Approved, still nothing selected: no export, and no way to select except the explicit human action.
  const slices = await (await page.request.get("/api/slices")).json();
  expect(slices.candidates).toHaveLength(3);
  expect(slices.selectedSlice).toBeNull();
  const noBrief = await page.request.get("/api/brief?format=json");
  expect(noBrief.status()).toBe(409);
  expect((await noBrief.json()).issues[0].code).toBe("selection_required");

  const beforeSelect = await storedText();
  const forged = YAML.parse(beforeSelect);
  forged.selectedSlice = {
    candidateId: "slice-outcome-thread",
    title: "x",
    stepIds: ["step-export-work"],
    personaIds: [],
    needIds: [],
    selectedBy: "An agent",
    selectedAt: "2026-10-02T09:00:00.000Z",
    revision: forged.revision.number,
    mapFingerprint: slices.mapFingerprint,
  };
  const sneaky = await page.request.put("/api/product", { data: YAML.stringify(forged) });
  expect(sneaky.status()).toBe(409);
  expect((await sneaky.json()).issues[0].code).toBe("implicit_selection");
  for (const body of [
    { candidateId: "slice-outcome-thread", selectedBy: "", mapFingerprint: slices.mapFingerprint },
    { candidateId: "slice-outcome-thread", selectedBy: HUMAN, mapFingerprint: "00000000" },
    { candidateId: "slice-made-up", selectedBy: HUMAN, mapFingerprint: slices.mapFingerprint },
  ])
    expect((await page.request.post("/api/slices/select", { data: body })).status()).toBe(409);
  expect(await storedText()).toBe(beforeSelect);

  // 7. Slice drawer: compare the candidates.
  await page.setViewportSize({ width: 1600, height: 2000 });
  await page.getByTestId("slices-open").click();
  const drawer = page.getByTestId("slice-drawer");
  await expect(page.getByTestId("slice-comparison").locator("thead th")).toHaveCount(4);
  await expect(page.getByTestId("candidate-slice-outcome-thread")).toContainText("Why now");
  await expect(drawer).toContainText("No slice is selected");
  await expect(page.getByTestId("export-work-order-json")).toHaveCount(0);
  await drawer.screenshot({ path: shot("06-slice-drawer-comparison") });

  // 8. Select slice: refused without a name, then done by a named human.
  await page.getByTestId("select-slice-outcome-thread").click();
  await expect(page.getByTestId("slice-issues")).toContainText("name of the human");
  expect(await storedText()).toBe(beforeSelect);
  await page.getByLabel("Selector name").fill(HUMAN);
  await page.getByTestId("select-slice-outcome-thread").click();
  await expect(page.getByTestId("selection-record")).toContainText(HUMAN);
  await expect(page.getByTestId("select-slice-outcome-thread")).toHaveText("Selected");
  await expect(page.getByTestId("export-work-order-md")).toHaveAttribute("href", "/api/brief?format=md");
  await drawer.screenshot({ path: shot("07-slice-selected-export-work-order") });

  // 9. Export work order: JSON and Markdown, naming the exact map revision.
  const canon = await stored();
  expect(canon.selectedSlice).toMatchObject({ candidateId: "slice-outcome-thread", selectedBy: HUMAN, revision: 3 });
  const json = await page.request.get(await page.getByTestId("export-work-order-json").getAttribute("href") as string);
  expect(json.status()).toBe(200);
  expect(json.headers()["content-disposition"]).toContain("asm.work-order.r3.json");
  const brief = await json.json();
  expect(brief.sourceMapRevision).toEqual({
    productId: "asm",
    productName: "ASM – Agentic Story Mapping",
    schemaVersion: 1,
    revision: canon.revision.number,
    status: "approved",
    approvedBy: HUMAN,
    approvedAt: canon.revision.approval.approvedAt,
    mapFingerprint: canon.selectedSlice.mapFingerprint,
  });
  expect(brief.sourceMapRevision.mapFingerprint).toBe(slices.mapFingerprint);
  expect(brief.inScope.map((s: { id: string }) => s.id)).toEqual(canon.selectedSlice.stepIds);
  const markdown = await (await page.request.get("/api/brief?format=md")).text();
  expect(markdown).toContain("## SOURCE MAP REVISION");
  expect(markdown).toContain(`- Revision: 3 (approved)`);
  await fs.mkdir(EXAMPLES, { recursive: true });
  await fs.writeFile(path.join(EXAMPLES, "asm.work-order.json"), await json.text());
  await fs.writeFile(path.join(EXAMPLES, "asm.work-order.md"), markdown);

  await page.getByTestId("slices-close").click();
  await page.setViewportSize({ width: 2800, height: 1400 });
  await expect(page.getByTestId("selected-slice-badge")).toContainText("Thread to");
  await expect(page.getByTestId("column-step-export-work")).toHaveAttribute("data-in-slice", "true");
  await expect(page.getByTestId("column-step-start-product")).toHaveAttribute("data-in-slice", "false");
  await page.screenshot({ path: shot("08-map-with-selected-slice"), fullPage: true });

  // The selection is bound to the map: a change of meaning ends it, and with it the export.
  await page.getByTestId("review-toggle").click();
  const card = page.getByTestId("card-step-export-work");
  await card.getByRole("button", { name: /^Edit/ }).click();
  await card.locator("textarea[name='description']").fill("Changed after selection.");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByTestId("selected-slice-badge")).toHaveCount(0);
  expect((await stored()).selectedSlice).toBeUndefined();
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(409);
});

test("the review endpoint reads and never writes", async ({ request }) => {
  const before = await storedText();
  const response = await request.post("/api/review");
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.review.findings).toHaveLength(8);
  expect(body.deterministic.filter((f: { code: string }) => f.code === "wcbc_without_outcome")).toHaveLength(6);
  expect(await storedText()).toBe(before);

  // A finding reaches the map only through the accept endpoint, and then only as a proposed revision.
  const patch = {
    patchVersion: 1,
    provider: body.review.provider,
    baseFingerprint: body.review.baseFingerprint,
    baseRevision: body.review.baseRevision,
    summary: body.review.summary,
    operations: [body.review.findings[0].operation],
  };
  const accepted = await request.post("/api/proposal/accept", { data: { patch } });
  expect(accepted.status()).toBe(200);
  expect((await accepted.json()).product.revision).toEqual({ number: 2, status: "proposed" });

  // The same findings are stale now.
  const again = await request.post("/api/proposal/accept", { data: { patch } });
  expect(again.status()).toBe(409);
  expect((await again.json()).issues[0].code).toBe("stale_patch");
});
