import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";
import { resetProductFile } from "./global-setup";

const SCREENSHOT = path.join(SCREENSHOTS, "asm-story-map.png");

test.describe.configure({ mode: "serial" });
test.beforeAll(resetProductFile);

test("the ASM story map is visible", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("load-error")).toHaveCount(0);
  await expect(page.getByTestId("product-name")).toHaveText("ASM – Agentic Story Mapping");
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
  await expect(page.getByTestId("goal-statement")).toContainText(
    "Software teams without prior AI experience",
  );

  const map = page.getByTestId("story-map");
  await expect(map).toBeVisible();
  await expect(map.locator("[data-kind='step']")).toHaveCount(11);
  await expect(map.locator("[data-kind='step'] h3").first()).toHaveText("Start product");
  await expect(map.locator("[data-kind='step'] h3").last()).toHaveText("Export execution-ready work");
  await expect(map.locator("[data-kind='wcbc']").first()).toBeVisible();
  await expect(page.getByTestId("persona-filter").locator("option")).toHaveCount(4);

  // Wide enough to show all eleven steps without horizontal scrolling.
  await page.setViewportSize({ width: 2800, height: 1000 });
  await page.screenshot({ path: SCREENSHOT, fullPage: true });
});

test("the persona filter keeps the narrative and focuses matching steps", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("persona-filter").selectOption("persona-developer");

  await expect(page.locator("[data-kind='step']")).toHaveCount(11);
  await expect(page.getByTestId("column-step-export-work")).toHaveAttribute("data-in-focus", "true");
  await expect(page.getByTestId("column-step-start-product")).toHaveAttribute("data-in-focus", "false");
});

test("editing a card persists to the canonical file and keeps its id", async ({ page }) => {
  await page.goto("/");
  const card = page.getByTestId("card-step-start-product");
  await card.getByRole("button", { name: /^Edit/ }).click();
  await card.locator("textarea[name='title']").fill("Start a product map");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.locator("h3")).toHaveText("Start a product map");

  await page.reload();
  await expect(page.getByTestId("card-step-start-product").locator("h3")).toHaveText(
    "Start a product map",
  );

  const stored = YAML.parse(await fs.readFile(E2E_PRODUCT_FILE, "utf8"));
  const step = stored.narrative.find((s: { id: string }) => s.id === "step-start-product");
  expect(step.title).toBe("Start a product map");
  expect(step.sequence).toBe(1);
});

test("approval is an explicit human action and a later edit reopens the revision", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("issues")).toContainText("name of the approving human");
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");

  await page.getByLabel("Approver name").fill("E2E Tester");
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("revision-status")).toHaveText("approved");
  await expect(page.getByTestId("approval-record")).toContainText("E2E Tester");

  const card = page.getByTestId("card-step-confirm-intent");
  await card.getByRole("button", { name: /^Edit/ }).click();
  await card.locator("textarea[name='description']").fill("Changed after approval.");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("revision-status")).toHaveText("proposed");
});

test("export and import round-trip over HTTP, and invalid or implicitly approved files are refused", async ({
  request,
}) => {
  const exported = await request.get("/api/product?format=yaml");
  expect(exported.status()).toBe(200);
  expect(exported.headers()["content-disposition"]).toContain("asm.product.yaml");
  const yaml = await exported.text();

  const imported = await request.post("/api/product/import", { data: yaml });
  expect(imported.status()).toBe(200);
  expect(await (await request.get("/api/product?format=yaml")).text()).toBe(yaml);

  const viaJson = await (await request.get("/api/product?format=json")).text();
  expect((await request.post("/api/product/import", { data: viaJson })).status()).toBe(200);
  expect(await (await request.get("/api/product?format=yaml")).text()).toBe(yaml);

  const broken = YAML.parse(yaml);
  broken.wcbc[0].stepId = "step-ghost";
  const rejected = await request.post("/api/product/import", { data: YAML.stringify(broken) });
  expect(rejected.status()).toBe(422);
  expect((await rejected.json()).issues[0].code).toBe("unknown_step");
  expect(await fs.readFile(E2E_PRODUCT_FILE, "utf8")).toBe(yaml);

  const sneaky = YAML.parse(yaml);
  sneaky.revision = {
    number: sneaky.revision.number,
    status: "approved",
    approval: { approvedBy: "Nobody", approvedAt: "2026-10-01T10:00:00.000Z" },
  };
  const refused = await request.put("/api/product", { data: YAML.stringify(sneaky) });
  expect(refused.status()).toBe(409);
  expect(await fs.readFile(E2E_PRODUCT_FILE, "utf8")).toBe(yaml);
});
