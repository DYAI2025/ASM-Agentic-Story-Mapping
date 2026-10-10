import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The backstop of tests/seed-guard.setup.ts: whatever wrote it, a unit test run
 * that leaves product/ different from how it found it fails, and the change
 * stays on disk to be looked at.
 */
const PRODUCT_DIR = fileURLToPath(new URL("../product", import.meta.url));

async function digest(): Promise<string> {
  const hash = createHash("sha256");
  for (const name of (await fs.readdir(PRODUCT_DIR)).sort()) {
    const file = path.join(PRODUCT_DIR, name);
    const stat = await fs.lstat(file);
    hash.update(`${name}\0${stat.isFile() ? "file" : "other"}\0`);
    if (stat.isFile()) hash.update(await fs.readFile(file));
  }
  return hash.digest("hex");
}

export default async function setup() {
  const before = await digest();
  return async () => {
    if ((await digest()) !== before)
      throw new Error("seed guard: product/ changed during the unit test run; see `git status product/` before running anything else");
  };
}
