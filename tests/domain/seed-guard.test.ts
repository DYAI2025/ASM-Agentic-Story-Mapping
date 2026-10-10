import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProduct, productFilePath, saveProduct } from "../../src/server/store";

/**
 * No unit test writes the repository's own map. On 2026-10-10 a test that
 * timed out under load kept running after its afterEach had removed
 * ASM_PRODUCT_FILE, and its late save fell back to product/asm.product.yaml.
 * tests/seed-guard.setup.ts refuses every write into product/ in every test
 * file; tests/seed-guard.global.ts fails the run if product/ changed anyway.
 */
interface SeedGuard {
  take(): string[];
}
const guard = () => (globalThis as Record<symbol, unknown>)[Symbol.for("asm.seed-guard")] as SeedGuard | undefined;
const SEED = path.join(process.cwd(), "product", "asm.product.yaml");

describe("no unit test writes the repository's own map", () => {
  afterEach(() => {
    delete process.env.ASM_PRODUCT_FILE;
  });

  it("is in place in every test file", () => {
    expect(guard()).toBeDefined();
  });

  it("refuses a save that falls back to the repository's map, which stays byte for byte as it was", async () => {
    // Checked before anything is written: without the guard this test would itself write the map.
    expect(guard()).toBeDefined();
    const before = readFileSync(SEED);
    delete process.env.ASM_PRODUCT_FILE;
    expect(productFilePath()).toBe(SEED);
    const loaded = await loadProduct();
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    try {
      await expect(saveProduct(loaded.product)).rejects.toThrow(/seed guard/);
      expect(guard()!.take().some((attempt) => attempt.includes(path.join("product", "asm.product.yaml")))).toBe(true);
    } finally {
      const after = readFileSync(SEED);
      // A guard that let the write through must not leave the working tree changed as well.
      if (!after.equals(before)) writeFileSync(SEED, before);
      expect(after.equals(before)).toBe(true);
    }
  });

  it("refuses the same directory however the path is spelled", async () => {
    expect(guard()).toBeDefined();
    await expect(fs.writeFile(path.join("tests", "..", "product", "probe.tmp"), "x")).rejects.toThrow(/seed guard/);
    await expect(fs.copyFile(SEED, path.join("product", "copy.yaml"))).rejects.toThrow(/seed guard/);
    expect(guard()!.take()).toHaveLength(2);
  });

  it("leaves reading the map and writing anywhere else alone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asm-seed-guard-"));
    try {
      await fs.copyFile(SEED, path.join(dir, "copy.yaml"));
      await fs.writeFile(path.join(dir, "a"), "x");
      await fs.rename(path.join(dir, "a"), path.join(dir, "b"));
      await fs.rm(path.join(dir, "b"));
      expect(await fs.readFile(path.join(dir, "copy.yaml"))).toEqual(readFileSync(SEED));
      expect(guard()!.take()).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
