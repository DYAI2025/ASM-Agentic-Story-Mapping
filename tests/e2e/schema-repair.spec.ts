import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import YAML from "yaml";
import { E2E_REPAIR_PRODUCT_FILE, E2E_REPAIR_WORK_STATE_FILE, MODEL_STUB_PORT, REPAIR_PORT } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";
import { FIXTURE_FILE } from "./global-setup";

/**
 * ASM-29 at the browser boundary, without a real model or key: the app runs
 * its real `openai` adapter against a scripted model on localhost
 * (`model-stub-server.ts`) whose first answer has the shape External QA
 * recorded from the reference model. The product asks once more with the
 * contract; a valid repaired answer is reviewed and becomes canon only on
 * Accept, an answer that never has the shape is refused after two calls and
 * nothing is written.
 */
test.use({ baseURL: `http://127.0.0.1:${REPAIR_PORT}` });
test.describe.configure({ mode: "serial" });

const STUB = `http://127.0.0.1:${MODEL_STUB_PORT}`;
const TEXT = [
  "Goal: Residents collect parcels whenever they come home.",
  "Persona: Resident — Lives in the building and receives parcels.",
  "Need (Resident): Know when a parcel has arrived.",
  "Step: Collect the parcel — The resident opens the compartment with a code. [personas: Resident] [needs: Know when a parcel has arrived]",
].join("\n");
const NEVER_IN_SHAPE = `${TEXT}\n[stub:never-in-shape]`;

type StubCall = { repair: boolean; contract: boolean; keyInBody: boolean; authorized: boolean };
const stubCalls = async (): Promise<StubCall[]> => (await fetch(`${STUB}/calls`)).json();
const exists = (file: string) => fs.access(file).then(() => true, () => false);

test.beforeEach(async () => {
  await fs.mkdir(path.dirname(E2E_REPAIR_PRODUCT_FILE), { recursive: true });
  await fs.rm(E2E_REPAIR_PRODUCT_FILE, { force: true });
  await fs.rm(E2E_REPAIR_WORK_STATE_FILE, { force: true });
  await fetch(`${STUB}/reset`, { method: "POST" });
});

async function structure(page: Page, route: "/api/bootstrap" | "/api/proposal", text: string) {
  await page.getByTestId("transcript-input").fill(text);
  const answer = page.waitForResponse((r) => r.url().endsWith(route) && r.request().method() === "POST");
  await page.getByTestId("structure-button").click();
  const response = await answer;
  return { status: response.status(), body: (await response.json()) as { modelCalls?: number; issues?: { code: string }[] } };
}

function expectOneRepair(calls: StubCall[]) {
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ repair: false, contract: false });
  expect(calls[1]).toMatchObject({ repair: true, contract: true });
  for (const call of calls) expect(call).toMatchObject({ authorized: true, keyInBody: false });
}

test("first map: an answer in the QA-observed shape is repaired once, reviewed, and becomes revision 1 only on Accept", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("start-screen")).toBeVisible();
  await page.getByTestId("product-name-input").fill("Parcel lockers");
  const { status, body } = await structure(page, "/api/bootstrap", TEXT);
  expect(status).toBe(200);
  expect(body.modelCalls).toBe(2);
  expectOneRepair(await stubCalls());

  // A proposal for the human, nothing saved.
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await expect(page.getByTestId("proposal-issues")).toHaveCount(0);
  await expect(page.getByTestId("preview-goal")).toHaveText("Residents collect parcels whenever they come home.");
  expect(await exists(E2E_REPAIR_PRODUCT_FILE)).toBe(false);
  await page.screenshot({ path: path.join(SCREENSHOTS, "asm29-01-repaired-proposal.png"), fullPage: true });

  // The existing explicit Human Accept is the only write.
  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByText("Revision 1", { exact: true })).toBeVisible();
  const stored = YAML.parse(await fs.readFile(E2E_REPAIR_PRODUCT_FILE, "utf8"));
  expect(stored.revision).toEqual({ number: 1, status: "proposed" });
  expect(stored.goal.statement).toBe("Residents collect parcels whenever they come home.");
  for (const entry of stored.provenance) expect(TEXT).toContain(entry.snippet);
  expect(await stubCalls()).toHaveLength(2);
});

test("first map: an answer that never has the shape is refused after two calls; nothing is created", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("product-name-input").fill("Parcel lockers");
  const { status, body } = await structure(page, "/api/bootstrap", NEVER_IN_SHAPE);
  expect(status).toBe(422);
  expect(body.modelCalls).toBe(2);
  expect((body.issues ?? []).every((issue) => issue.code.startsWith("agent_output_"))).toBe(true);
  expectOneRepair(await stubCalls());

  await expect(page.getByTestId("proposal-issues")).toBeVisible();
  await expect(page.getByTestId("proposal-review")).toHaveCount(0);
  expect(await exists(E2E_REPAIR_PRODUCT_FILE)).toBe(false);
  expect(await exists(E2E_REPAIR_WORK_STATE_FILE)).toBe(false);
  await page.screenshot({ path: path.join(SCREENSHOTS, "asm29-02-refused-after-repair.png"), fullPage: true });
});

test("existing map: a repaired answer is reviewed; the file changes only on Accept, to the next proposed revision", async ({ page }) => {
  await fs.copyFile(FIXTURE_FILE, E2E_REPAIR_PRODUCT_FILE);
  const before = await fs.readFile(E2E_REPAIR_PRODUCT_FILE, "utf8");
  const revision = YAML.parse(before).revision.number as number;
  await page.goto("/");
  const { status, body } = await structure(page, "/api/proposal", TEXT);
  expect(status).toBe(200);
  expect(body.modelCalls).toBe(2);
  expectOneRepair(await stubCalls());
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  expect(await fs.readFile(E2E_REPAIR_PRODUCT_FILE, "utf8")).toBe(before);

  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("proposal-status")).toContainText(`proposed revision ${revision + 1}`);
  const stored = YAML.parse(await fs.readFile(E2E_REPAIR_PRODUCT_FILE, "utf8"));
  expect(stored.revision).toEqual({ number: revision + 1, status: "proposed" });
});

test("existing map: an answer that never has the shape leaves the product file and the work state byte-identical", async ({ page }) => {
  await fs.copyFile(FIXTURE_FILE, E2E_REPAIR_PRODUCT_FILE);
  const workState = JSON.stringify({ workStateVersion: 1 });
  await fs.writeFile(E2E_REPAIR_WORK_STATE_FILE, workState);
  const before = await fs.readFile(E2E_REPAIR_PRODUCT_FILE, "utf8");
  await page.goto("/");
  const { status, body } = await structure(page, "/api/proposal", NEVER_IN_SHAPE);
  expect(status).toBe(422);
  expect(body.modelCalls).toBe(2);
  expectOneRepair(await stubCalls());
  await expect(page.getByTestId("proposal-issues")).toBeVisible();
  await expect(page.getByTestId("proposal-review")).toHaveCount(0);
  expect(await fs.readFile(E2E_REPAIR_PRODUCT_FILE, "utf8")).toBe(before);
  expect(await fs.readFile(E2E_REPAIR_WORK_STATE_FILE, "utf8")).toBe(workState);
});
