import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";

/**
 * ASM-26: the semantic proposal as the human sees it — grouped, each item
 * used, edited or rejected on its own, a goal with two readings as a choice
 * nobody makes for them, suggestion chips that only fill a draft field, and
 * the source on demand. The file is proven untouched until the human accepts.
 */
const NAME = "Parcel lockers";
const TEXT = [
  "Goal: Residents collect a parcel without waiting for a courier.",
  "Goal: Couriers deliver to the building in one stop.",
  "Persona: Resident — Lives in the building. [roles: customer, user]",
  "Persona: Courier — Delivers for several carriers. [roles: operator]",
  "Actor: Building manager — Owns the lobby. [roles: stakeholder]",
  "Need (Resident): Get my parcel on the day it arrives.",
  "Need (Courier): Drop a parcel in under a minute.",
  "Step: Courier loads the parcel — Into a free compartment. [personas: Courier] [needs: Drop a parcel in under a minute]",
  "Step: Resident opens the compartment — With the code. [personas: Resident] [needs: Get my parcel on the day it arrives]",
  "Do oversized parcels go somewhere else?",
].join("\n");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const exists = () => fs.access(E2E_PRODUCT_FILE).then(() => true, () => false);
const shot = (name: string) => path.join(SCREENSHOTS, `proposal-${name}.png`);

test.describe.configure({ mode: "serial" });
test.beforeEach(async () => {
  await fs.rm(E2E_PRODUCT_FILE, { force: true });
  await fs.rm(E2E_WORK_STATE_FILE, { force: true });
});

test("grouped review: choose a goal, edit a need with a chip, reject a step, accept the rest; nothing written before", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("product-name-input").fill(NAME);
  await page.getByTestId("transcript-input").fill(TEXT);
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();

  // Groups, in reading order; the goal is a choice with nothing chosen.
  for (const group of ["goal", "personas", "actors", "needs", "path", "questions"]) await expect(page.getByTestId(`proposal-section-${group}`)).toBeVisible();
  await expect(page.getByTestId("proposal-section-personas").locator("[data-testid^='diff-op-']")).toHaveCount(2);
  await expect(page.getByTestId("proposal-section-actors").locator("[data-testid^='diff-op-']")).toHaveCount(1);
  await expect(page.getByTestId("proposal-section-needs").locator("[data-testid^='diff-op-']")).toHaveCount(2);
  await expect(page.getByTestId("proposal-section-path").locator("[data-testid^='diff-op-']")).toHaveCount(2);
  await expect(page.getByTestId("goal-choice")).toContainText("ASM does not choose for you");
  await expect(page.locator("input[name='goal-choice']")).toHaveCount(2);
  await expect(page.locator("input[name='goal-choice']:checked")).toHaveCount(0);
  // Without a goal chosen, a first product cannot be accepted: the gate is the goal, not a guess.
  await expect(page.getByTestId("proposal-accept")).toBeDisabled();
  await expect(page.getByTestId("preview-goal")).toHaveCount(0);
  // The source is there on demand, not on the main screen.
  const source = page.getByTestId("source-op-3");
  await expect(source.locator("summary")).toContainText("Source: Pasted text");
  await expect(source.locator("blockquote")).toBeHidden();
  await source.locator("summary").click();
  await expect(source.locator("blockquote")).toBeVisible();
  await expect(source.locator("blockquote")).toContainText("Persona: Courier");
  await page.screenshot({ path: shot("01-grouped-with-goal-choice"), fullPage: true });

  // The human chooses the first reading; the alternative is left out of what would be sent.
  await page.getByLabel("Choose op-1", { exact: true }).check();
  await expect(page.locator("input[name='goal-choice']:checked")).toHaveCount(1);
  await expect(page.getByTestId("preview-goal")).toHaveText("Residents collect a parcel without waiting for a courier.");
  await expect(page.getByTestId("proposal-accept")).toBeEnabled();
  await page.getByLabel("Choose op-10", { exact: true }).check();
  await expect(page.getByTestId("preview-goal")).toHaveText("Couriers deliver to the building in one stop.");
  await page.getByLabel("Choose op-1", { exact: true }).check();

  // Edit one need through its own Edit, then take the chip: the field fills, the preview follows, nothing is written.
  await page.getByTestId("edit-op-5").click();
  const field = page.locator("textarea[name='op-5-statement']");
  await field.fill("Get the parcel the same day");
  await expect(page.getByTestId("preview-people")).toContainText("Get the parcel the same day");
  await page.getByTestId("chip-op-5-statement-0").click();
  await expect(field).toHaveValue("Need (Resident): Get my parcel on the day it arrives.");
  await field.fill("Get my parcel on the day it arrives, even late at night.");
  await page.getByTestId("edit-op-5").click();
  await expect(page.getByTestId("diff-op-5")).toContainText("even late at night");
  expect(await exists()).toBe(false);

  // Reject one step: it stays visible, marked rejected, and leaves the preview path.
  await page.getByLabel("Include op-7", { exact: true }).uncheck();
  await expect(page.getByTestId("diff-op-7")).toHaveAttribute("data-state", "rejected");
  await expect(page.getByTestId("diff-op-7")).toContainText("Rejected");
  await expect(page.getByTestId("preview-path").locator("li")).toHaveCount(1);
  await expect(page.getByTestId("proposal-accept")).toHaveText("Accept 8 changes");
  await page.screenshot({ path: shot("02-edited-and-partly-rejected"), fullPage: true });
  expect(await exists()).toBe(false);

  // Accept: revision 1, with exactly what was chosen, edited and kept.
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("product-name")).toHaveText(NAME);
  const stored = YAML.parse(await fs.readFile(E2E_PRODUCT_FILE, "utf8"));
  expect(stored.revision).toEqual({ number: 1, status: "proposed" });
  expect(stored.goal.statement).toBe("Residents collect a parcel without waiting for a courier.");
  expect(stored.needs.map((n: { statement: string }) => n.statement)).toContain("Get my parcel on the day it arrives, even late at night.");
  expect(stored.narrative.map((s: { title: string }) => s.title)).toEqual(["Resident opens the compartment"]);
  expect(stored.personas).toHaveLength(3);
  expect(stored.decisions.map((d: { status: string }) => d.status)).toEqual(["open"]);
  await page.screenshot({ path: shot("03-first-map-from-choices"), fullPage: true });
});

test("the server refuses a patch that still carries both goals: a choice cannot be skipped by a client", async ({ page }) => {
  await page.goto("/");
  const proposed = await page.request.post("/api/bootstrap", { data: { name: NAME, transcript: TEXT } });
  expect(proposed.status()).toBe(200);
  const { patch } = await proposed.json();
  expect(patch.operations.filter((o: { op: string }) => o.op === "set_goal")).toHaveLength(2);
  const both = await page.request.post("/api/bootstrap/accept", { data: { name: NAME, patch } });
  expect(both.status()).toBe(422);
  expect((await both.json()).issues[0].code).toBe("conflicting_goal");
  expect(await exists()).toBe(false);
  // A choice tag on anything but a goal, or an unknown field, is refused by the strict schema.
  const tagged = { ...patch, operations: patch.operations.map((o: { op: string }) => (o.op === "add_persona" ? { ...o, choice: "goal" } : o)) };
  expect((await page.request.post("/api/bootstrap/accept", { data: { name: NAME, patch: tagged } })).status()).toBe(422);
  expect(await exists()).toBe(false);
});

test("with one goal there is no choice, and the existing workshop still edits and accepts on a map", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("product-name-input").fill(NAME);
  await page.getByTestId("transcript-input").fill(TEXT.split("\n").filter((line) => !line.startsWith("Goal: Couriers")).join("\n"));
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await expect(page.getByTestId("goal-choice")).toHaveCount(0);
  await expect(page.getByTestId("proposal-section-goal").locator("input[type='checkbox']")).toHaveCount(1);
  await expect(page.getByTestId("preview-goal")).toHaveText("Residents collect a parcel without waiting for a courier.");
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("product-name")).toHaveText(NAME);
  const before = sha(await fs.readFile(E2E_PRODUCT_FILE, "utf8"));

  // On the map: a proposal with one persona; Edit all opens every field, the chip fills, reject leaves the file alone.
  await page.getByTestId("transcript-input").fill("Persona: Neighbour — Receives a parcel for someone else. [roles: user]");
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await page.getByTestId("proposal-edit").click();
  await expect(page.getByTestId("proposal-edit")).toHaveText("Done editing");
  await page.locator("textarea[name='op-1-description']").fill("x");
  await page.getByTestId("chip-op-1-description-0").click();
  await expect(page.locator("textarea[name='op-1-description']")).toHaveValue("Persona: Neighbour — Receives a parcel for someone else. [roles: user]");
  await page.getByTestId("proposal-reject").click();
  expect(sha(await fs.readFile(E2E_PRODUCT_FILE, "utf8"))).toBe(before);
});
