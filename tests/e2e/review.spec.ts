import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";
import { resetProductFile } from "./global-setup";

const HUMAN = "Maya (E2E)";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetProductFile);

const storedText = () => fs.readFile(E2E_PRODUCT_FILE, "utf8");
const stored = async () => YAML.parse(await storedText());
const workState = async () => JSON.parse(await fs.readFile(E2E_WORK_STATE_FILE, "utf8"));
const workStateExists = () => fs.access(E2E_WORK_STATE_FILE).then(() => true, () => false);
const shot = (name: string) => path.join(SCREENSHOTS, `review-${name}.png`);

test("the findings inbox names each kind of gap in plain words, and looking at it writes nothing", async ({ page }) => {
  // One of each: a step nobody does, a persona without a need, a step that serves no need.
  const doc = await stored();
  doc.personas.push({ id: "persona-auditor", name: "Auditor", description: "Checks the result." });
  doc.narrative.find((s: { id: string }) => s.id === "step-start-product").personaIds = [];
  await fs.writeFile(E2E_PRODUCT_FILE, YAML.stringify(doc));
  const before = await storedText();

  await page.setViewportSize({ width: 1600, height: 2200 });
  await page.goto("/");
  await page.getByTestId("review-toggle").click();
  const inbox = page.getByTestId("deterministic-findings");

  await expect(page.getByTestId("finding-label-step_without_persona:step-start-product")).toHaveText("Missing actor");
  await expect(page.getByTestId("finding-label-persona_without_need:persona-auditor")).toHaveText("Missing need");
  await expect(inbox.locator("[data-code='wcbc_without_outcome']").first().locator("[data-testid^='finding-label-']")).toHaveText("Missing outcome");
  // Every open decision is in the inbox, as something a human still has to decide.
  const open = doc.decisions.filter((d: { status: string }) => d.status === "open");
  await expect(inbox.locator("[data-code='unresolved_decision']")).toHaveCount(open.length);
  await expect(page.getByTestId(`finding-label-unresolved_decision:${open[0].id}`)).toHaveText("Unresolved decision");
  await expect(page.getByTestId(`finding-unresolved_decision:${open[0].id}`)).toContainText(open[0].title);

  // A missing transition is an agent finding: a proposal, shown only on request, selected by nobody.
  await page.getByTestId("agent-review-button").click();
  await expect(page.getByTestId("agent-findings").locator("[data-kind='missing_transition']").first()).toBeVisible();
  await expect(page.getByTestId("review-panel").locator("input[type='checkbox']:checked")).toHaveCount(0);

  // Findings and suggestions are derived and proposed; the file has not changed and nothing is approved.
  expect(await storedText()).toBe(before);
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await page.getByTestId("review-panel").screenshot({ path: shot("01-findings-with-plain-labels") });
});

test("approval is a named human's, for one revision; saving cannot keep it while changing what was approved", async ({ page }) => {
  await page.goto("/");
  // No name, no approval.
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("issues")).toContainText("name of the approving human");
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");

  await page.getByLabel("Approver name").fill(HUMAN);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("approval-record")).toContainText(HUMAN);
  const approved = await stored();
  expect(approved.revision).toMatchObject({ number: 1, status: "approved", approval: { approvedBy: HUMAN } });
  const bytes = await storedText();
  await page.screenshot({ path: shot("02-approved-by-a-named-human"), fullPage: true });

  // The same approval record, another meaning: refused, file unchanged.
  const tampered = structuredClone(approved);
  tampered.goal.statement = "Something nobody approved.";
  const put = await page.request.put("/api/product", { data: YAML.stringify(tampered) });
  expect(put.status()).toBe(409);
  expect((await put.json()).issues[0].code).toBe("approved_content_changed");
  const added = structuredClone(approved);
  added.personas.push({ id: "persona-sneaked-in", name: "Sneaked in", description: "" });
  expect((await page.request.put("/api/product", { data: YAML.stringify(added) })).status()).toBe(409);
  expect(await storedText()).toBe(bytes);

  // Only where a card sits may change under an approval.
  const moved = structuredClone(approved);
  moved.layout.cards["step-main-path"] = { row: 2 };
  expect((await page.request.put("/api/product", { data: YAML.stringify(moved) })).status()).toBe(200);
  expect((await stored()).revision).toEqual(approved.revision);

  // An edit through the editor is a change of meaning: it opens the next revision and the approval is gone.
  await page.reload();
  const card = page.getByTestId("card-step-export-work");
  await card.getByRole("button", { name: /^Edit/ }).click();
  await card.locator("textarea[name='description']").fill("Changed after approval.");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  expect((await stored()).revision).toEqual({ number: 2, status: "proposed" });
});

test("who else matters: asked after approval, answered only by a named human, stale after a change", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1800 });
  await page.goto("/");

  // On a proposed map there is nothing to confirm yet, over the UI or over HTTP.
  await page.getByTestId("slices-open").click();
  await expect(page.getByTestId("people-check")).toHaveCount(0);
  await expect(page.getByTestId("slice-needs-approval")).toBeVisible();
  const slicesProposed = await (await page.request.get("/api/slices")).json();
  const early = await page.request.post("/api/people-check", { data: { confirmedBy: HUMAN, mapFingerprint: slicesProposed.mapFingerprint } });
  expect(early.status()).toBe(409);
  expect((await early.json()).issues[0].message).toContain("not approved");
  await page.getByTestId("slices-close").click();

  await page.getByLabel("Approver name").fill(HUMAN);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  const canon = await storedText();
  const slices = await (await page.request.get("/api/slices")).json();
  expect(slices.personaCheck).toBeNull();
  expect(slices.personaCheckCurrent).toBe(false);

  // Over HTTP: no name, or a map other than the one looked at, confirms nothing.
  for (const body of [
    { confirmedBy: "", mapFingerprint: slices.mapFingerprint },
    { confirmedBy: HUMAN, mapFingerprint: "00000000" },
    {},
  ])
    expect((await page.request.post("/api/people-check", { data: body })).status()).toBe(409);
  expect(await workStateExists()).toBe(false);

  // In the drawer: the people are listed, ASM claims nothing, and the human confirms with a name.
  await page.getByTestId("slices-open").click();
  const check = page.getByTestId("people-check");
  await expect(check).toHaveAttribute("data-state", "none");
  await expect(page.getByTestId("people-check-list").locator("li")).toHaveCount(3);
  await expect(check).toContainText("ASM cannot know whether someone relevant for this goal is missing");
  await expect(page.getByTestId("select-slice-outcome-thread")).toBeDisabled();
  await check.screenshot({ path: shot("03-who-else-matters") });
  await page.getByLabel("Confirmed by").fill(HUMAN);
  await page.getByTestId("people-check-confirm").click();
  await expect(page.getByTestId("people-check-record")).toContainText(`Confirmed by ${HUMAN}`);
  await expect(page.getByTestId("people-check-record")).toContainText("This does not say the list is complete");
  await expect(page.getByTestId("select-slice-outcome-thread")).toBeEnabled();
  await check.screenshot({ path: shot("04-confirmed-by-a-named-human") });

  // Work state, not canon: the product file has not changed by a byte.
  expect(await storedText()).toBe(canon);
  expect(await workState()).toEqual({
    workStateVersion: 1,
    personaCheck: { productId: "asm", revision: 1, mapFingerprint: slices.mapFingerprint, confirmedBy: HUMAN, confirmedAt: expect.any(String) },
  });
  await page.getByTestId("slices-close").click();

  // Someone is added to the map: the confirmation is stale, shown as stale, and no slice can be selected.
  const personaCard = page.getByTestId("card-persona-developer");
  await personaCard.getByRole("button", { name: "Edit Persona persona-developer" }).click();
  await personaCard.locator("textarea[name='description']").fill("Also reviews the slice.");
  await personaCard.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await page.getByLabel("Approver name").fill(HUMAN);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "people_check");
  await expect(page.getByTestId("guide-stale-people_check")).toBeVisible();

  await page.getByTestId("slices-open").click();
  await expect(check).toHaveAttribute("data-state", "stale");
  await expect(page.getByTestId("people-check-stale")).toContainText("Stale confirmation");
  await expect(page.getByTestId("select-slice-outcome-thread")).toBeDisabled();
  await check.screenshot({ path: shot("05-confirmation-stale-after-change") });
  const after = await (await page.request.get("/api/slices")).json();
  const refused = await page.request.post("/api/slices/select", {
    data: { candidateId: "slice-outcome-thread", selectedBy: HUMAN, mapFingerprint: after.mapFingerprint },
  });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).issues[0].message).toContain("made on an earlier map");
  // The stale confirmation is still in the work state: nothing deleted or renewed it.
  expect((await workState()).personaCheck.mapFingerprint).toBe(slices.mapFingerprint);
  expect((await workState()).selection).toBeUndefined();
});

// The work-state file is trusted as a record, like the product file: a complete-looking record written by hand
// is taken as one. What the file cannot do is leave the confirmation out, or claim more than a human can say.
test("a hand-edited work-state file: a selection without the confirmation record is stale; a record that claims more is refused", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Approver name").fill(HUMAN);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  const slices = await (await page.request.get("/api/slices")).json();
  const candidate = slices.candidates[0];

  // A selection written into the file with no record of a confirmation: stale, no export.
  await fs.writeFile(
    E2E_WORK_STATE_FILE,
    JSON.stringify({
      workStateVersion: 1,
      selection: {
        candidateId: candidate.id,
        productId: "asm",
        revision: 1,
        mapFingerprint: slices.mapFingerprint,
        candidateFingerprint: "00000000",
        derivationVersion: slices.derivationVersion,
        selectedBy: "Nobody",
        selectedAt: "2026-10-02T09:00:00.000Z",
      },
    }),
  );
  const brief = await page.request.get("/api/brief?format=json");
  expect(brief.status()).toBe(409);
  expect((await brief.json()).issues[0]).toMatchObject({ code: "stale_selection", path: "selection.personaCheck" });
  await page.reload();
  await expect(page.getByTestId("stale-slice-badge")).toBeVisible();

  // A confirmation with a field that claims more than a human said: the file is refused as a whole.
  await fs.writeFile(
    E2E_WORK_STATE_FILE,
    JSON.stringify({
      workStateVersion: 1,
      personaCheck: { productId: "asm", revision: 1, mapFingerprint: slices.mapFingerprint, confirmedBy: "Agent", confirmedAt: "2026-10-02T09:00:00.000Z", allPersonasFound: true },
    }),
  );
  expect((await page.request.get("/api/slices")).status()).toBe(500);
  await page.reload();
  await expect(page.getByTestId("load-error")).toContainText("work-state file could not be loaded");
});

test("with the guide hidden, a stale people check is still visible on the toolbar, and reselecting starts there", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("guide-hide").click();
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
  await expect(page.getByTestId("stale-people-check-badge")).toHaveCount(0);

  // A change of meaning, then approval again: both records are stale, and the toolbar says so without the guide.
  const card = page.getByTestId("card-step-export-work");
  await card.getByRole("button", { name: /^Edit/ }).click();
  await card.locator("textarea[name='description']").fill("Changed after confirmation.");
  await card.getByRole("button", { name: "Save" }).click();
  await page.getByLabel("Approver name").fill(HUMAN);
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await expect(page.getByTestId("guide")).toHaveCount(0);
  await expect(page.getByTestId("stale-slice-badge")).toBeVisible();
  await expect(page.getByTestId("stale-people-check-badge")).toBeVisible();

  // In the drawer, "reselect" leads to the people check first, because that comes first.
  await page.getByTestId("slices-open").click();
  await expect(page.getByTestId("reselect-candidates")).toHaveText("Confirm who else matters, then reselect");
  await page.getByTestId("reselect-candidates").click();
  await expect(page.getByLabel("Confirmed by")).toBeFocused();
  await page.keyboard.type(HUMAN);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("people-check-record")).toBeVisible();
  await expect(page.getByTestId("reselect-candidates")).toHaveText("Reselect from current candidates");
  await page.getByTestId("reselect-candidates").click();
  await expect(page.getByLabel("Selector name")).toBeFocused();
});
