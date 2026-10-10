import { spawnSync } from "node:child_process";
import { promises as fs, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The seed guard's enforcement, run for real (external review round 7): a
 * second vitest runs one small test file at a time in a disposable copy of the
 * guard and of product/, with that copy as its working directory, so the
 * repository's own map cannot be reached from it. What seed-guard.test.ts
 * cannot show from inside one file is shown by the exit status and the output
 * of that run: a swallowed refusal still fails the file, a write past the
 * guard fails the run, and the late save of 2026-10-10 is refused.
 */
const REPO = process.cwd();
const VITEST = path.join(REPO, "node_modules", "vitest", "vitest.mjs");
const STORE = path.join(REPO, "src", "server", "store.ts");
let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "asm-seed-guard-run-"));
  await fs.mkdir(path.join(root, "tests"));
  await fs.mkdir(path.join(root, "product"));
  for (const name of ["seed-guard.setup.ts", "seed-guard.global.ts"])
    await fs.copyFile(path.join(REPO, "tests", name), path.join(root, "tests", name));
  await fs.copyFile(path.join(REPO, "product", "asm.product.yaml"), path.join(root, "product", "asm.product.yaml"));
  await fs.symlink(path.join(REPO, "node_modules"), path.join(root, "node_modules"));
  await fs.writeFile(
    path.join(root, "vitest.config.mts"),
    [
      'import { defineConfig } from "vitest/config";',
      "export default defineConfig({",
      '  test: { environment: "node", include: ["tests/**/*.test.ts"], setupFiles: ["tests/seed-guard.setup.ts"], globalSetup: ["tests/seed-guard.global.ts"] },',
      "});",
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function run(name: string, body: string): { status: number | null; output: string } {
  // A fresh product/ per run, so that what one run left behind cannot decide the next (verifier, candidate e4531f6).
  rmSync(path.join(root, "product"), { recursive: true, force: true });
  mkdirSync(path.join(root, "product"));
  copyFileSync(path.join(REPO, "product", "asm.product.yaml"), path.join(root, "product", "asm.product.yaml"));
  const file = path.join(root, "tests", `${name}.test.ts`);
  writeFileSync(file, body);
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const key of Object.keys(env)) if (/^(VITEST|TINYPOOL|FORCE_COLOR)/.test(key) || key === "ASM_PRODUCT_FILE") delete env[key];
  try {
    const result = spawnSync(process.execPath, [VITEST, "run", `tests/${name}.test.ts`], { cwd: root, env, encoding: "utf8", timeout: 100_000 });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(file, { force: true });
  }
}

describe("the seed guard, run in a disposable copy", () => {
  it("lets a file that writes nowhere near product/ pass", () => {
    const result = run("control", 'import { it } from "vitest";\nit("writes nothing", () => {});\n');
    expect(result.output).toContain("1 passed");
    expect(result.status).toBe(0);
  }, 120_000);

  it("fails a file whose write into product/ was refused and swallowed", () => {
    const result = run(
      "swallowed",
      [
        'import { promises as fs } from "node:fs";',
        'import { it } from "vitest";',
        'it("swallows the refusal", async () => {',
        '  await fs.writeFile("product/probe.tmp", "x").catch(() => {});',
        "});",
        "",
      ].join("\n"),
    );
    expect(result.output).toContain("seed guard: this file tried to write the repository's own map: writeFile");
    expect(result.status).toBe(1);
    expect(existsSync(path.join(root, "product", "probe.tmp"))).toBe(false);
  }, 120_000);

  it("refuses the late save of a test that outlived its timeout, and leaves the map byte for byte", () => {
    const before = readFileSync(path.join(root, "product", "asm.product.yaml"));
    const result = run(
      "late-save",
      [
        'import { promises as fs } from "node:fs";',
        'import os from "node:os";',
        'import path from "node:path";',
        'import { afterEach, beforeEach, describe, it } from "vitest";',
        `import { loadProduct, saveProduct } from ${JSON.stringify(STORE)};`,
        'describe("a test whose hooks unset the product file", () => {',
        '  let dir = "";',
        "  beforeEach(async () => {",
        '    dir = await fs.mkdtemp(path.join(os.tmpdir(), "asm-late-save-"));',
        '    const file = path.join(dir, "asm.product.yaml");',
        '    await fs.copyFile("product/asm.product.yaml", file);',
        "    process.env.ASM_PRODUCT_FILE = file;",
        "  });",
        "  afterEach(async () => {",
        "    delete process.env.ASM_PRODUCT_FILE;",
        "    await fs.rm(dir, { recursive: true, force: true });",
        "  });",
        '  it("outlives its timeout and saves late", async () => {',
        "    const loaded = await loadProduct();",
        '    if (!loaded.ok) throw new Error("load");',
        "    await new Promise((resolve) => setTimeout(resolve, 300));",
        "    await saveProduct(loaded.product);",
        "  }, 100);",
        "});",
        'it("keeps the file running after the hooks", async () => {',
        "  await new Promise((resolve) => setTimeout(resolve, 1000));",
        "});",
        "",
      ].join("\n"),
    );
    expect(result.output).toContain("Test timed out in 100ms");
    // Any characters up to the file name: a temporary directory may hold spaces, and its real path may differ from os.tmpdir() (review round 8).
    expect(result.output).toMatch(/seed guard: this file tried to write the repository's own map: writeFile [^\n]*asm\.product\.yaml\.[0-9a-f-]+\.tmp/);
    expect(result.status).toBe(1);
    expect(readFileSync(path.join(root, "product", "asm.product.yaml")).equals(before)).toBe(true);
  }, 120_000);

  it("fails the run when product/ changed past the guard", () => {
    const result = run(
      "past-the-guard",
      'import { writeFileSync } from "node:fs";\nimport { it } from "vitest";\nit("writes synchronously", () => {\n  writeFileSync("product/probe.tmp", "x");\n});\n',
    );
    expect(result.output).toContain("seed guard: product/ changed during the unit test run");
    expect(result.status).toBe(1);
  }, 120_000);
});
