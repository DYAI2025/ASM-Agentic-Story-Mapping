import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";
import { resetProductFile } from "./global-setup";

test.describe.configure({ mode: "serial" });
test.beforeEach(resetProductFile);

const storedText = () => fs.readFile(E2E_PRODUCT_FILE, "utf8");
const stored = async () => YAML.parse(await storedText());
const shot = (name: string) => path.join(SCREENSHOTS, `actors-${name}.png`);

test("an existing map is shown as it was written: personas, no role stated, and nothing is written by looking", async ({ page }) => {
  const before = await storedText();
  await page.goto("/");
  for (const id of ["persona-product-lead", "persona-domain-ux", "persona-developer"]) {
    await expect(page.getByTestId(`roles-${id}`)).toHaveText("Role not stated");
    await expect(page.getByTestId(`perspective-${id}`)).toHaveText("Persona");
    await expect(page.getByTestId(`unresolved-${id}`)).toHaveCount(0);
  }
  expect(await storedText()).toBe(before);
  expect(before).not.toMatch(/roles:|persona:/);
});

test("a human states roles; the persona answer stays what it was and is not written", async ({ page }) => {
  await page.goto("/");
  const card = page.getByTestId("card-persona-developer");
  await card.getByRole("button", { name: "Roles and persona… Developer" }).click();
  const form = page.getByTestId("actor-form-persona-developer");
  await form.getByLabel("Delivery participant").check();
  await form.getByLabel("User", { exact: true }).check();
  await form.getByRole("button", { name: "Save roles" }).click();

  await expect(page.getByTestId("roles-persona-developer")).toHaveText("UserDelivery participant");
  // Being a delivery participant changed nothing about being a persona.
  await expect(page.getByTestId("perspective-persona-developer")).toHaveText("Persona");
  const developer = (await stored()).personas.find((e: { id: string }) => e.id === "persona-developer");
  expect(developer.roles).toEqual(["user", "delivery_participant"]);
  expect("persona" in developer).toBe(false);
  await page.screenshot({ path: shot("01-roles-stated"), fullPage: true });
});

test("opening the form and saving without a change writes nothing, also on an approved map", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Approver name").fill("Maya (E2E)");
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  const before = await storedText();
  await page.getByTestId("card-persona-developer").getByRole("button", { name: "Roles and persona… Developer" }).click();
  const form = page.getByTestId("actor-form-persona-developer");
  // Keyboard focus is in the form as soon as it opens.
  await expect(form.getByLabel("Customer / buyer")).toBeFocused();
  await form.getByRole("button", { name: "Save roles" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  expect(await storedText()).toBe(before);
});

test("an actor who owns a need cannot be switched to 'not a persona'", async ({ page }) => {
  await page.goto("/");
  const before = await storedText();
  await page.getByTestId("card-persona-developer").getByRole("button", { name: "Roles and persona… Developer" }).click();
  const form = page.getByTestId("actor-form-persona-developer");
  await form.getByLabel(/^Persona:/).uncheck();
  await form.getByRole("button", { name: "Save roles" }).click();
  await expect(page.getByTestId("issues")).toContainText("an actor whose need is on the map is a persona");
  await expect(page.getByTestId("perspective-persona-developer")).toHaveText("Persona");
  expect(await storedText()).toBe(before);
});

test("a delivery participant who is not a persona, then a persona without a need: unresolved, and no need appears", async ({ page }) => {
  // Someone new on the map with no need, added the way a hand edit or an import would.
  const doc = await stored();
  doc.personas.push({ id: "persona-build-engineer", name: "Build engineer", description: "Builds the slice.", roles: ["delivery_participant"], persona: false });
  await fs.writeFile(E2E_PRODUCT_FILE, YAML.stringify(doc));
  const needsBefore = doc.needs.length;

  await page.goto("/");
  await expect(page.getByTestId("load-error")).toHaveCount(0);
  await expect(page.getByTestId("roles-persona-build-engineer")).toHaveText("Delivery participant");
  await expect(page.getByTestId("perspective-persona-build-engineer")).toContainText("Not a persona");
  await expect(page.getByTestId("unresolved-persona-build-engineer")).toHaveCount(0);
  // Not a persona: the guide has nothing to ask about them.
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "approve");
  await page.screenshot({ path: shot("02-delivery-participant-not-a-persona"), fullPage: true });

  // The human says: this one is a persona. Now a need is missing, and that is shown, not filled in.
  await page.getByTestId("card-persona-build-engineer").getByRole("button", { name: "Roles and persona… Build engineer" }).click();
  const form = page.getByTestId("actor-form-persona-build-engineer");
  await form.getByLabel(/^Persona:/).check();
  await form.getByRole("button", { name: "Save roles" }).click();
  await expect(page.getByTestId("perspective-persona-build-engineer")).toHaveText("Persona");
  await expect(page.getByTestId("unresolved-persona-build-engineer")).toContainText("Unresolved");
  await expect(page.getByTestId("guide")).toHaveAttribute("data-current-step", "people");

  await page.getByTestId("review-toggle").click();
  await expect(page.getByTestId("finding-persona_without_need:persona-build-engineer")).toContainText("has no need on the map");
  const after = await stored();
  expect(after.needs).toHaveLength(needsBefore);
  expect(after.personas.at(-1)).toMatchObject({ roles: ["delivery_participant"], persona: true });
  await page.screenshot({ path: shot("03-persona-without-need-unresolved"), fullPage: true });
});

test("a file with a role that does not exist is refused, not reinterpreted", async ({ page }) => {
  const doc = await stored();
  doc.personas[0].roles = ["developer"];
  const response = await page.request.put("/api/product", { data: YAML.stringify(doc) });
  expect(response.status()).toBe(422);
  expect((await response.json()).issues[0].path).toBe("personas.0.roles.0");
});
