import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";
import { resetProductFile } from "./global-setup";

const TRANSCRIPT_FILE = path.join(__dirname, "..", "fixtures", "workshop-transcript.txt");
import { EXAMPLES, SCREENSHOTS } from "./artifacts";
const HUMAN = "Maya (E2E)";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetProductFile);

const storedText = () => fs.readFile(E2E_PRODUCT_FILE, "utf8");
const stored = async () => YAML.parse(await storedText());
const workState = async () => JSON.parse(await fs.readFile(E2E_WORK_STATE_FILE, "utf8"));
const workStateExists = () => fs.access(E2E_WORK_STATE_FILE).then(() => true, () => false);
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
  expect(slices.selection).toBeNull();
  expect(slices.selectionStale).toBe(false);
  expect(Object.values(slices.valueStatus)).toEqual(["VALUE_RESOLVED", "VALUE_RESOLVED", "VALUE_RESOLVED"]);
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
  // The product document has no place for a selection: such a file is not a valid product.
  expect(sneaky.status()).toBe(422);
  expect((await sneaky.json()).issues[0].code).toBe("schema_unrecognized_keys");
  for (const body of [
    { candidateId: "slice-outcome-thread", selectedBy: "", mapFingerprint: slices.mapFingerprint },
    { candidateId: "slice-outcome-thread", selectedBy: HUMAN, mapFingerprint: "00000000" },
    { candidateId: "slice-made-up", selectedBy: HUMAN, mapFingerprint: slices.mapFingerprint },
  ])
    expect((await page.request.post("/api/slices/select", { data: body })).status()).toBe(409);
  expect(await storedText()).toBe(beforeSelect);
  expect(await workStateExists()).toBe(false);

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
  await expect(page.getByTestId("value-status")).toHaveAttribute("data-value", "VALUE_RESOLVED");
  await expect(page.getByTestId("value-exception-form")).toHaveCount(0);
  await expect(page.getByTestId("export-work-order-md")).toHaveAttribute("href", "/api/brief?format=md");
  await drawer.screenshot({ path: shot("07-slice-selected-export-work-order") });

  // Selecting wrote the work state and left the product file byte for byte as it was.
  expect(await storedText()).toBe(beforeSelect);
  const selection = (await workState()).selection;
  expect(selection).toMatchObject({
    candidateId: "slice-outcome-thread",
    productId: "asm",
    selectedBy: HUMAN,
    revision: 3,
    mapFingerprint: slices.mapFingerprint,
    derivationVersion: slices.derivationVersion,
  });
  expect(selection.candidateFingerprint).toMatch(/^[0-9a-f]{8}$/);

  // 9. Export work order: JSON and Markdown, naming the exact map revision.
  const canon = await stored();
  expect(canon.selectedSlice).toBeUndefined();
  const json = await page.request.get(await page.getByTestId("export-work-order-json").getAttribute("href") as string);
  expect(json.status()).toBe(200);
  expect(json.headers()["content-disposition"]).toContain("asm.work-order.r3.json");
  const brief = await json.json();
  expect(brief.briefVersion).toBe(2);
  expect(brief.sourceMapRevision).toEqual({
    productId: "asm",
    productName: "ASM – Agentic Story Mapping",
    schemaVersion: 1,
    revision: canon.revision.number,
    status: "approved",
    approvedBy: HUMAN,
    approvedAt: canon.revision.approval.approvedAt,
    mapFingerprint: selection.mapFingerprint,
  });
  expect(brief.sourceMapRevision.mapFingerprint).toBe(slices.mapFingerprint);
  expect(brief.inScope.map((s: { id: string }) => s.id)).toEqual(slices.candidates[1].stepIds);
  expect(brief.approvedContext.selection).toMatchObject({
    candidateId: "slice-outcome-thread",
    candidateFingerprint: selection.candidateFingerprint,
    derivationVersion: selection.derivationVersion,
  });
  expect(brief.approvedContext.value.status).toBe("VALUE_RESOLVED");
  expect(brief.approvedContext.value.exception).toBeUndefined();
  const markdown = await (await page.request.get("/api/brief?format=md")).text();
  expect(markdown).toContain("Work order contract: `asm.execution-brief`, briefVersion 2.");
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

  // The selection is bound to the map: a change of meaning makes it stale, and with it the export.
  await page.getByTestId("review-toggle").click();
  const card = page.getByTestId("card-step-export-work");
  await card.getByRole("button", { name: /^Edit/ }).click();
  await card.locator("textarea[name='description']").fill("Changed after selection.");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByTestId("selected-slice-badge")).toHaveCount(0);
  await expect(page.getByTestId("stale-slice-badge")).toBeVisible();
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(409);
  // Nothing deleted the selection: it is still in the work state and no longer matches the map.
  expect((await workState()).selection).toEqual(selection);
  const after = await (await page.request.get("/api/slices")).json();
  expect(after.selectionStale).toBe(true);
  expect(after.mapFingerprint).not.toBe(selection.mapFingerprint);

  // Approved again, the old selection stays stale: the export names the reason.
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  const staleBrief = await page.request.get("/api/brief?format=json");
  expect(staleBrief.status()).toBe(409);
  expect((await staleBrief.json()).issues[0]).toMatchObject({ code: "stale_selection", path: "selection.mapFingerprint" });
  await expect(page.getByTestId("selected-slice-badge")).toHaveCount(0);
  await expect(page.getByTestId("stale-slice-badge")).toBeVisible();

  // 10. The drawer shows the stale selection as stale, not as "nothing selected", and offers no export.
  await page.setViewportSize({ width: 1600, height: 2000 });
  await page.getByTestId("slices-open").click();
  await expect(page.getByTestId("slice-gate")).toHaveAttribute("data-selection-state", "stale");
  await expect(page.getByTestId("stale-heading")).toContainText("Stale selection");
  await expect(page.getByTestId("stale-previous")).toContainText("slice-outcome-thread");
  await expect(page.getByTestId("stale-previous")).toContainText("Thread to");
  await expect(page.getByTestId("stale-previous")).toContainText(HUMAN);
  await expect(page.getByTestId("stale-reason")).toContainText("Product Map changed");
  await expect(page.getByTestId("stale-reason")).toHaveAttribute("data-reason", "selection.mapFingerprint");
  await expect(drawer).not.toContainText("No slice is selected");
  await expect(page.getByTestId("selection-record")).toHaveCount(0);
  await expect(page.getByTestId("export-work-order-md")).toHaveCount(0);
  await expect(page.getByTestId("export-work-order-json")).toHaveCount(0);
  await expect(page.getByTestId("select-slice-outcome-thread")).toHaveText("Select slice");
  await drawer.screenshot({ path: shot("11-stale-selection") });
  // Showing it repaired, replaced and deleted nothing.
  expect((await workState()).selection).toEqual(selection);
  expect((await page.request.get("/api/brief?format=md")).status()).toBe(409);

  // Only a human selecting again replaces it; then the drawer is back to an ordinary selection.
  await page.getByTestId("reselect-candidates").click();
  await expect(page.getByLabel("Selector name")).toBeFocused();
  await page.getByLabel("Selector name").fill(HUMAN);
  await page.getByTestId("select-slice-outcome-thread").click();
  await expect(page.getByTestId("selection-record")).toContainText(HUMAN);
  await expect(page.getByTestId("slice-gate")).toHaveAttribute("data-selection-state", "current");
  await expect(page.getByTestId("selection-stale")).toHaveCount(0);
  const fresh = await (await page.request.get("/api/slices")).json();
  expect(fresh.selectionStale).toBe(false);
  expect((await workState()).selection.mapFingerprint).toBe(fresh.mapFingerprint);
  expect(fresh.mapFingerprint).not.toBe(selection.mapFingerprint);
  const again = await page.request.get("/api/brief?format=json");
  expect(again.status()).toBe(200);
  expect((await again.json()).briefVersion).toBe(2);
  await page.getByTestId("slices-close").click();
  await expect(page.getByTestId("stale-slice-badge")).toHaveCount(0);
  await expect(page.getByTestId("selected-slice-badge")).toContainText("Thread to");
});

test("a slice without a need: shown and selectable, exported only after an explicit exception", async ({ page }) => {
  test.setTimeout(120_000);
  // A map on which the steps shared between personas reference no need.
  const needless = YAML.parse(await storedText());
  for (const step of needless.narrative) if (step.personaIds.length > 1) step.needIds = [];
  await fs.writeFile(E2E_PRODUCT_FILE, YAML.stringify(needless));

  await page.setViewportSize({ width: 1600, height: 2000 });
  await page.goto("/");
  await page.getByLabel("Approver name").fill(HUMAN);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  const canonBytes = await storedText();

  // Viewed and compared like any other candidate.
  await page.getByTestId("slices-open").click();
  const drawer = page.getByTestId("slice-drawer");
  await expect(page.locator("[data-testid^='candidate-slice-']")).toHaveCount(3);
  await expect(page.getByTestId("flag-slice-shared-steps")).toBeVisible();
  const valueRow = page.getByTestId("slice-comparison").locator("tr", { hasText: "VALUE_" });
  await expect(valueRow.locator("td")).toHaveText(["VALUE_RESOLVED", "VALUE_RESOLVED", "VALUE_UNRESOLVED"]);

  // Selecting it is allowed and does not make it exportable.
  await page.getByLabel("Selector name").fill(HUMAN);
  await page.getByTestId("select-slice-shared-steps").click();
  await expect(page.getByTestId("selection-record")).toContainText("Steps shared between personas");
  await expect(page.getByTestId("value-status")).toHaveAttribute("data-value", "VALUE_UNRESOLVED");
  await expect(page.getByTestId("export-work-order-md")).toHaveCount(0);
  await expect(page.getByTestId("export-work-order-json")).toHaveCount(0);
  const refused = await page.request.get("/api/brief?format=json");
  expect(refused.status()).toBe(409);
  expect((await refused.json()).issues[0].code).toBe("value_unresolved");
  expect((await page.request.get("/api/brief?format=md")).status()).toBe(409);
  await drawer.screenshot({ path: shot("09-value-unresolved-no-export") });

  // An empty rationale is rejected, in the drawer and at the endpoint.
  await page.getByLabel("Exception accepted by").fill(HUMAN);
  await page.getByTestId("accept-value-exception").click();
  await expect(page.getByTestId("slice-issues")).toContainText("requires a rationale");
  for (const body of [
    { rationale: "   ", acceptedBy: HUMAN },
    { acceptedBy: HUMAN },
    { rationale: "A reason.", acceptedBy: "" },
  ])
    expect((await page.request.post("/api/slices/exception", { data: body })).status()).toBe(409);
  expect((await workState()).selection.valueException).toBeUndefined();
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(409);

  // A named human accepts the exception with a rationale. Now it can be exported, and the brief says so.
  const RATIONALE = "The hand-over points have to work before we can observe which need they serve.";
  await page.getByLabel("Exception rationale").fill(RATIONALE);
  await page.getByTestId("accept-value-exception").click();
  await expect(page.getByTestId("value-status")).toHaveAttribute("data-value", "VALUE_EXCEPTION_ACCEPTED");
  await expect(page.getByTestId("value-exception-record")).toContainText(RATIONALE);
  await expect(page.getByTestId("value-exception-record")).toContainText("not proof of value");
  await drawer.screenshot({ path: shot("10-value-exception-accepted") });

  const json = await page.request.get(await page.getByTestId("export-work-order-json").getAttribute("href") as string);
  expect(json.status()).toBe(200);
  const brief = await json.json();
  expect(brief.briefVersion).toBe(2);
  expect(brief.goal.slice.id).toBe("slice-shared-steps");
  expect(brief.approvedContext.value).toMatchObject({
    status: "VALUE_EXCEPTION_ACCEPTED",
    needIds: [],
    exception: { rationale: RATIONALE, acceptedBy: HUMAN },
  });
  const markdown = await (await page.request.get("/api/brief?format=md")).text();
  expect(markdown).toContain("- Value: VALUE_EXCEPTION_ACCEPTED. Exception accepted by Maya (E2E)");
  expect(markdown).toContain("briefVersion 2.");
  expect(markdown).toContain(RATIONALE);
  await fs.mkdir(EXAMPLES, { recursive: true });
  await fs.writeFile(path.join(EXAMPLES, "asm.work-order.exception.json"), await json.text());
  await fs.writeFile(path.join(EXAMPLES, "asm.work-order.exception.md"), markdown);

  // None of this touched the product file.
  expect(await storedText()).toBe(canonBytes);

  // A slice that references a need needs no exception, and selecting again drops the old one.
  await page.getByTestId("select-slice-outcome-thread").click();
  await expect(page.getByTestId("value-status")).toHaveAttribute("data-value", "VALUE_RESOLVED");
  expect((await workState()).selection.valueException).toBeUndefined();
  expect((await page.request.post("/api/slices/exception", { data: { rationale: RATIONALE, acceptedBy: HUMAN } })).status()).toBe(409);
  expect((await page.request.get("/api/brief?format=json")).status()).toBe(200);
  expect(await storedText()).toBe(canonBytes);
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
