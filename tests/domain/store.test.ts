import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateCard } from "../../src/domain/operations";
import { loadProduct, productFilePath, saveProduct } from "../../src/server/store";
import { FIXTURE_PATH, fixtureText, loadFixture } from "./helpers";

describe("file-backed store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "asm-store-"));
  });

  afterEach(async () => {
    delete process.env.ASM_PRODUCT_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("the app's loader reads the ASM fixture from its default location", async () => {
    expect(productFilePath()).toBe(FIXTURE_PATH);
    const result = await loadProduct();
    expect(result.ok).toBe(true);
    expect(result.ok && result.product.product.id).toBe("asm");
    expect(result.ok && result.product.narrative).toHaveLength(11);
  });

  it("persists an edit and reads it back", async () => {
    process.env.ASM_PRODUCT_FILE = path.join(dir, "p.yaml");
    await fs.writeFile(process.env.ASM_PRODUCT_FILE, fixtureText());

    const edited = updateCard(loadFixture(), "step-start-product", { title: "Begin" });
    expect((await saveProduct(edited)).ok).toBe(true);

    const reloaded = await loadProduct();
    expect(reloaded.ok && reloaded.product).toEqual(edited);
  });

  it("never writes an invalid document", async () => {
    process.env.ASM_PRODUCT_FILE = path.join(dir, "p.yaml");
    await fs.writeFile(process.env.ASM_PRODUCT_FILE, fixtureText());

    const broken = structuredClone(loadFixture());
    broken.wcbc[0].stepId = "step-ghost";
    expect((await saveProduct(broken)).ok).toBe(false);
    expect(await fs.readFile(process.env.ASM_PRODUCT_FILE, "utf8")).toBe(fixtureText());
  });

  it("reports a missing file as an issue instead of throwing", async () => {
    process.env.ASM_PRODUCT_FILE = path.join(dir, "missing.yaml");
    const result = await loadProduct();
    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("file_unreadable");
  });
});
