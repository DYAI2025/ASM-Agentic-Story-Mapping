import { promises as fs } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import YAML from "yaml";
import { E2E_PRODUCT_FILE, E2E_WORK_STATE_FILE } from "../../playwright.config";
import { SCREENSHOTS } from "./artifacts";

/**
 * ASM-24: a first-time user brings what they have — pasted text and text or
 * markdown files — without learning a syntax. Sources keep their identity
 * through to the provenance of what the human accepts. Every refusal leaves
 * no file behind.
 */
const NAME = "Parcel lockers";
const exists = () => fs.access(E2E_PRODUCT_FILE).then(() => true, () => false);
const shot = (name: string) => path.join(SCREENSHOTS, `intake-${name}.png`);

const NOTES_MD = [
  "# Notes from the lobby walk",
  "Persona: Resident — Lives in the building and comes home late. [roles: customer, user]",
  "Need (Resident): Get my parcel on the day it arrives.",
].join("\n");
const TRANSCRIPT_TXT = [
  "Maya: Step: Courier loads the parcel — Into a free compartment. [personas: Courier]",
  "Maya: Step: Resident opens the compartment — With the code from the notification. [personas: Resident] [needs: Get my parcel on the day it arrives]",
  "Ben: Do we need a second locker bank?",
].join("\n");
const PASTED = ["Goal: Residents collect a parcel without waiting for a courier.", "Persona: Courier — Delivers for several carriers. [roles: operator]"].join("\n");

const file = (name: string, text: string, mimeType = "text/plain") => ({ name, mimeType, buffer: Buffer.from(text, "utf8") });

test.describe.configure({ mode: "serial" });
test.beforeEach(async () => {
  await fs.rm(E2E_PRODUCT_FILE, { force: true });
  await fs.rm(E2E_WORK_STATE_FILE, { force: true });
});

test("the start screen asks for existing material; the marker format is a note, not the instruction", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What do you want to build or improve?" })).toBeVisible();
  await expect(page.getByTestId("intake-intro")).toContainText("Paste anything you already have: meeting notes, a transcript, a product description, requirements or rough thoughts.");
  await expect(page.getByTestId("intake-intro")).not.toContainText("Goal:");
  // The fake provider is configured for the browser tests, so the format note exists, collapsed.
  const hint = page.getByTestId("marker-hint");
  await expect(hint).toBeVisible();
  await expect(hint.locator("pre")).toBeHidden();
  await page.screenshot({ path: shot("01-start-screen"), fullPage: true });
});

test("no name yet: the button is not dead; it says what is missing and moves the focus there, keeping the text", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("transcript-input").fill(PASTED);
  await expect(page.getByTestId("structure-button")).toBeEnabled();
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-status")).toContainText("Give it a working name first");
  await expect(page.getByTestId("product-name-input")).toBeFocused();
  await expect(page.getByTestId("transcript-input")).toHaveValue(PASTED);
  await expect(page.getByTestId("proposal-review")).toHaveCount(0);
  expect(await exists()).toBe(false);
});

test("pasted text plus two files: sources are listed, removable, and each accepted item names where it came from", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("product-name-input").fill(NAME);
  await page.getByTestId("transcript-input").fill(PASTED);
  await page.getByTestId("context-files").setInputFiles([file("notes.md", NOTES_MD, "text/markdown"), file("transcript.txt", TRANSCRIPT_TXT), file("empty.txt", "   \n")]);

  // Two sources added with stable ids; the empty file refused by name, nothing else lost.
  const sources = page.getByTestId("context-sources");
  await expect(sources.locator("li")).toHaveCount(2);
  await expect(page.getByTestId("context-source-src-2")).toContainText("notes.md");
  await expect(page.getByTestId("context-source-src-3")).toContainText("transcript.txt");
  await expect(page.getByTestId("proposal-issues")).toContainText("\"empty.txt\" has no text in it");
  await page.screenshot({ path: shot("02-context-bundle"), fullPage: true });

  // A third file is removed before sending; its id is not reused by the next one.
  await page.getByTestId("context-files").setInputFiles([file("later.txt", "Question: Is there a budget?")]);
  await expect(page.getByTestId("context-source-src-4")).toContainText("later.txt");
  await page.getByRole("button", { name: "Remove later.txt" }).click();
  await expect(sources.locator("li")).toHaveCount(2);
  await page.getByTestId("context-files").setInputFiles([file("again.txt", "Question: Is there a budget?")]);
  await expect(page.getByTestId("context-source-src-5")).toContainText("again.txt");
  await page.getByRole("button", { name: "Remove again.txt" }).click();
  await expect(sources.locator("li")).toHaveCount(2);

  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  // Items from the three sources, each labelled with its source.
  await expect(page.getByTestId("source-of-op-1")).toHaveText("Pasted text");
  await expect(page.getByTestId("diff-op-2")).toContainText("Courier");
  await expect(page.getByTestId("source-of-op-2")).toHaveText("Pasted text");
  await expect(page.getByTestId("diff-op-3")).toContainText("Resident");
  await expect(page.getByTestId("source-of-op-3")).toHaveText("notes.md");
  await expect(page.getByTestId("source-of-op-5")).toHaveText("transcript.txt");
  await expect(page.getByTestId("preview-path").locator("li")).toHaveCount(2);
  expect(await exists()).toBe(false);
  await page.screenshot({ path: shot("03-proposal-with-sources"), fullPage: true });

  await page.getByTestId("proposal-accept").click();
  await expect(page.getByTestId("product-name")).toHaveText(NAME);
  const stored = YAML.parse(await fs.readFile(E2E_PRODUCT_FILE, "utf8"));
  const bySource = new Map<string, string[]>();
  for (const entry of stored.provenance) bySource.set(entry.sourceLabel, [...(bySource.get(entry.sourceLabel) ?? []), entry.targetId]);
  expect(bySource.get("Pasted text")).toEqual(["goal-parcel-lockers", "persona-courier"]);
  expect(bySource.get("notes.md")).toEqual(["persona-resident", "need-get-my-parcel-on-the-day-it-arrives"]);
  expect(bySource.get("transcript.txt")?.length).toBe(3);
  expect(stored.provenance.every((entry: { sourceId?: string }) => /^src-[1-3]$/.test(entry.sourceId ?? ""))).toBe(true);
  // The editor shows the source on the card.
  await page.getByTestId("provenance-persona-resident").locator("summary").click();
  await expect(page.getByTestId("provenance-persona-resident")).toContainText("from “notes.md”");
  await page.getByTestId("card-persona-resident").screenshot({ path: shot("04-provenance-on-card") });
});

test("files only, no pasted text, is enough", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("product-name-input").fill(NAME);
  await expect(page.getByTestId("structure-button")).toBeDisabled();
  await page.getByTestId("context-files").setInputFiles([file("all.md", `${PASTED}\n${NOTES_MD}`, "text/markdown")]);
  await expect(page.getByTestId("structure-button")).toBeEnabled();
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-review")).toBeVisible();
  await expect(page.getByTestId("source-of-op-1")).toHaveText("all.md");
  expect(await exists()).toBe(false);
});

test("what is refused, and that nothing is written: wrong type, undecodable bytes, over the limit, and clear input", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("product-name-input").fill(NAME);

  await page.getByTestId("context-files").setInputFiles([file("deck.pdf", "%PDF-1.4 not text", "application/pdf")]);
  await expect(page.getByTestId("proposal-issues")).toContainText("\"deck.pdf\" is not a .txt or .md file");
  await expect(page.getByTestId("context-sources")).toHaveCount(0);

  await page.getByTestId("context-files").setInputFiles([{ name: "latin1.txt", mimeType: "text/plain", buffer: Buffer.from([0x47, 0x6f, 0x61, 0x6c, 0x3a, 0x20, 0xe4, 0xff, 0xfe]) }]);
  await expect(page.getByTestId("proposal-issues")).toContainText("\"latin1.txt\" could not be read as UTF-8 text");
  await expect(page.getByTestId("context-sources")).toHaveCount(0);

  // Over the limit, caught by the server: the bundle is validated before any provider sees it.
  await page.getByTestId("transcript-input").fill(`Goal: x\n${"y".repeat(60_001)}`);
  await page.getByTestId("structure-button").click();
  await expect(page.getByTestId("proposal-issues")).toContainText("the limit is 60000 per source");
  await expect(page.getByTestId("proposal-review")).toHaveCount(0);

  // A server-side refusal of a smuggled binary source, past the browser's checks.
  const smuggled = await page.request.post("/api/bootstrap", {
    data: { name: NAME, context: { sources: [{ id: "src-1", label: "x.txt", kind: "file", text: "Goal: a\u0000b" }] } },
  });
  expect(smuggled.status()).toBe(422);
  expect((await smuggled.json()).issues[0].code).toBe("binary_content");
  const wrongShape = await page.request.post("/api/bootstrap", { data: { name: NAME, context: { sources: [{ id: "x", text: "Goal: a" }] } } });
  expect(wrongShape.status()).toBe(422);
  const noContext = await page.request.post("/api/bootstrap", { data: { name: NAME } });
  expect(noContext.status()).toBe(400);
  // The old one-string body still works.
  const legacy = await page.request.post("/api/bootstrap", { data: { name: NAME, transcript: PASTED } });
  expect(legacy.status()).toBe(200);
  expect((await legacy.json()).patch.operations[0].source).toMatchObject({ sourceId: "src-1", sourceLabel: "Pasted text" });

  // Clear input drops the files as well as the text.
  await page.getByTestId("transcript-input").fill(PASTED);
  await page.getByTestId("context-files").setInputFiles([file("notes.md", NOTES_MD, "text/markdown")]);
  await expect(page.getByTestId("context-sources").locator("li")).toHaveCount(1);
  await page.getByTestId("clear-input").click();
  await expect(page.getByTestId("transcript-input")).toHaveValue("");
  await expect(page.getByTestId("context-sources")).toHaveCount(0);
  await expect(page.getByTestId("structure-button")).toBeDisabled();

  expect(await exists()).toBe(false);
});
