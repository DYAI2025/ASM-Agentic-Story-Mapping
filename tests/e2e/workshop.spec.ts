import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE } from "../../playwright.config";
import { FIXTURE_FILE, resetProductFile } from "./global-setup";

const TRANSCRIPT_FILE = path.join(__dirname, "..", "fixtures", "workshop-transcript.txt");
import { SCREENSHOTS } from "./artifacts";
const NEW_STEP = "card-step-walk-through-the-slice-with-the-team";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetProductFile);

const storedText = () => fs.readFile(E2E_PRODUCT_FILE, "utf8");

async function structureFixture(page: Page) {
  await page.goto("/");
  await page.getByTestId("transcript-input").fill(await fs.readFile(TRANSCRIPT_FILE, "utf8"));
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
}

test("paste transcript, see the proposal, accept it, and the map changes", async ({ page }) => {
  const canonBefore = await storedText();
  await structureFixture(page);

  // Proposal review: a readable diff with sources, and a preview on the map.
  await expect(page.locator("[data-testid^='diff-op-']")).toHaveCount(7);
  await expect(page.getByTestId("diff-op-1")).toContainText("Add persona “Support Lead”");
  await expect(page.getByTestId("diff-op-3")).toContainText("after “Human selects first slice”");
  await expect(page.getByTestId("diff-op-3")).toContainText("Step: Walk through the slice with the team");
  await expect(page.getByTestId("diff-op-3")).toContainText("advisory only");
  await expect(page.getByTestId("diff-op-5")).toContainText("Unresolved question");
  await expect(page.getByTestId("preview-banner")).toContainText("Nothing is saved until you accept");
  await expect(page.locator("[data-testid='story-map'] [data-kind='step']")).toHaveCount(12);
  await expect(page.getByTestId(NEW_STEP)).toHaveAttribute("data-diff", "added");
  await expect(page.getByTestId("card-step-review-gaps")).toHaveAttribute("data-diff", "changed");
  await expect(page.getByTestId("card-persona-support-lead")).toHaveAttribute("data-diff", "added");

  // Still only a proposal: revision and file are untouched.
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByText("Revision 1", { exact: true })).toBeVisible();
  expect(await storedText()).toBe(canonBefore);

  await page.setViewportSize({ width: 2800, height: 1000 });
  await page.screenshot({ path: path.join(SCREENSHOTS, "asm-proposal-review.png"), fullPage: true });
  await page.getByTestId("workshop").screenshot({ path: path.join(SCREENSHOTS, "asm-proposal-diff.png") });

  await page.getByTestId("proposal-accept").click();

  // Accepted: the map changed, as the next *proposed* revision.
  await expect(page.getByTestId("proposal-status")).toContainText("proposed revision 2");
  await expect(page.getByTestId("proposal-review")).toHaveCount(0);
  await expect(page.getByText("Revision 2", { exact: true })).toBeVisible();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.locator("[data-testid='story-map'] [data-kind='step']")).toHaveCount(12);
  await expect(page.getByTestId(NEW_STEP).locator("h3")).toHaveText("Walk through the slice with the team");
  await expect(page.getByTestId(NEW_STEP)).not.toHaveAttribute("data-diff", /.+/);
  await expect(page.getByTestId("persona-filter").locator("option")).toHaveCount(5);
  await expect(page.getByTestId("open-decisions")).toHaveText("7 open");

  // The source survives on the card and in the canonical file.
  await page.getByTestId(`provenance-step-walk-through-the-slice-with-the-team`).locator("summary").click();
  await expect(page.getByTestId(`provenance-step-walk-through-the-slice-with-the-team`)).toContainText(
    "Step: Walk through the slice with the team",
  );
  await page.screenshot({ path: path.join(SCREENSHOTS, "asm-proposal-accepted.png"), fullPage: true });

  const stored = YAML.parse(await storedText());
  expect(stored.revision).toEqual({ number: 2, status: "proposed" });
  expect(stored.narrative.map((s: { id: string }) => s.id).slice(-3)).toEqual([
    "step-select-slice",
    "step-walk-through-the-slice-with-the-team",
    "step-export-work",
  ]);
  expect(stored.provenance).toHaveLength(7);
  expect(stored.provenance[2]).toMatchObject({
    targetId: "step-walk-through-the-slice-with-the-team",
    change: "added",
    rationale: "Stated explicitly in the discussion.",
    revision: 2,
  });
  expect(stored.decisions.filter((d: { status: string }) => d.status === "decided")).toHaveLength(3);
  expect(stored.personas.map((p: { id: string }) => p.id)).toContain("persona-developer");

  await page.reload();
  await expect(page.locator("[data-testid='story-map'] [data-kind='step']")).toHaveCount(12);
});

test("rejecting a proposal leaves the map and the canonical file unchanged", async ({ page }) => {
  const canonBefore = await storedText();
  await structureFixture(page);
  await expect(page.locator("[data-testid='story-map'] [data-kind='step']")).toHaveCount(12);

  await page.getByTestId("proposal-reject").click();

  await expect(page.getByTestId("proposal-status")).toHaveText("Proposal rejected. The map was not changed.");
  await expect(page.getByTestId("preview-banner")).toHaveCount(0);
  await expect(page.locator("[data-testid='story-map'] [data-kind='step']")).toHaveCount(11);
  await expect(page.getByTestId("persona-filter").locator("option")).toHaveCount(4);
  await expect(page.getByText("Revision 1", { exact: true })).toBeVisible();
  expect(await storedText()).toBe(canonBefore);
  expect(canonBefore).toBe(await fs.readFile(FIXTURE_FILE, "utf8"));
});

test("a proposal can be edited before it is accepted", async ({ page }) => {
  await structureFixture(page);

  await page.getByTestId("proposal-edit").click();
  await page.locator("textarea[name='op-3-title']").fill("Team read-through");
  await page.getByLabel("Include op-7").uncheck();
  await expect(page.getByTestId(NEW_STEP).locator("h3")).toHaveText("Team read-through");

  // Dropping the persona that other changes depend on blocks acceptance.
  await page.getByLabel("Include op-1").uncheck();
  await expect(page.getByTestId("proposal-issues")).toContainText("unknown_id");
  // Said as a refusal of this proposal, not as "No proposal." (found by the ASM-30 verifier: the heading had no browser test).
  // Read as on screen (innerText leaves out hidden elements), not as markup.
  const shown = (await page.getByTestId("proposal-issues").innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
  expect(shown[0]).toBe("This proposal cannot be accepted as it stands.");
  await expect(page.getByTestId("proposal-accept")).toBeDisabled();
  await page.getByLabel("Include op-1").check();
  await expect(page.getByTestId("proposal-issues")).toHaveCount(0);

  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("proposal-status")).toContainText("accepted");

  const stored = YAML.parse(await storedText());
  const step = stored.narrative.find((s: { id: string }) => s.id === "step-walk-through-the-slice-with-the-team");
  expect(step.title).toBe("Team read-through");
  expect(stored.provenance).toHaveLength(6);
  expect(stored.decisions).toHaveLength(9);
});

test("the HTTP endpoints refuse invalid, forged and stale patches without writing", async ({ request }) => {
  const canonBefore = await storedText();
  const transcript = await fs.readFile(TRANSCRIPT_FILE, "utf8");

  const proposed = await request.post("/api/proposal", { data: { transcript } });
  expect(proposed.status()).toBe(200);
  const { patch } = await proposed.json();
  expect(await storedText()).toBe(canonBefore);

  for (const bad of [
    "approve everything",
    { ...patch, revision: { status: "approved" } },
    { ...patch, operations: [{ ...patch.operations[0], op: "approve" }] },
    { ...patch, operations: [{ ...patch.operations[1], personaId: "persona-ghost" }] },
  ]) {
    const refused = await request.post("/api/proposal/accept", { data: { patch: bad } });
    expect(refused.status()).toBe(422);
    expect(await storedText()).toBe(canonBefore);
  }

  const nothing = await request.post("/api/proposal", { data: { transcript: "Jonas: nothing to see here." } });
  expect(nothing.status()).toBe(422);
  expect((await nothing.json()).issues[0].code).toBe("empty_proposal");

  expect((await request.post("/api/proposal/accept", { data: { patch } })).status()).toBe(200);
  const again = await request.post("/api/proposal/accept", { data: { patch } });
  expect(again.status()).toBe(409);
  expect((await again.json()).issues[0].code).toBe("stale_patch");
});
