import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

/**
 * No unit test writes the repository's own map. Tests point ASM_PRODUCT_FILE
 * at a temporary file, but the store falls back to product/asm.product.yaml
 * when it is unset, and a test body that outlives its timeout keeps running
 * after its afterEach has unset it: on 2026-10-10 a late save under load
 * rewrote the map. Every write the store makes goes through the one shared
 * `fs.promises` object, so each write into product/ is refused here, in every
 * test file, and a file that tried fails even where the refusal was swallowed.
 * tests/seed-guard.global.ts checks the directory after the run as a backstop
 * for anything that does not go through this object.
 */
const PRODUCT_DIR = fileURLToPath(new URL("../product", import.meta.url));
const KEY = Symbol.for("asm.seed-guard");

/** The argument positions that name a place written to; reading the map stays allowed. */
const WRITES: Record<string, number[]> = {
  writeFile: [0],
  appendFile: [0],
  truncate: [0],
  open: [0],
  rename: [0, 1],
  link: [0, 1],
  symlink: [1],
  copyFile: [1],
  cp: [1],
  unlink: [0],
  rm: [0],
  rmdir: [0],
  chmod: [0],
  utimes: [0],
};

interface SeedGuard {
  attempts: string[];
  take(): string[];
}

function asPath(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  return null;
}

function insideProduct(target: string): boolean {
  const resolved = path.resolve(target);
  return resolved === PRODUCT_DIR || resolved.startsWith(PRODUCT_DIR + path.sep);
}

const readOnlyFlags = (flags: unknown) => flags === undefined || flags === "r" || flags === "rs" || flags === 0;

const registry = globalThis as Record<symbol, unknown>;
if (!registry[KEY]) {
  const guard: SeedGuard = { attempts: [], take: () => guard.attempts.splice(0) };
  registry[KEY] = guard;
  const methods = fs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const [name, positions] of Object.entries(WRITES)) {
    const original = methods[name];
    if (typeof original !== "function") continue;
    methods[name] = (...args: unknown[]) => {
      for (const position of positions) {
        const target = asPath(args[position]);
        if (target === null || !insideProduct(target) || (name === "open" && readOnlyFlags(args[1]))) continue;
        const attempt = `${name} ${path.resolve(target)}`;
        guard.attempts.push(attempt);
        const refusal = new Error(`seed guard: a test tried to ${attempt}, inside the repository's own map; point ASM_PRODUCT_FILE at a temporary file`);
        return Promise.reject(Object.assign(refusal, { code: "ASM_SEED_GUARD" }));
      }
      return original.apply(fs, args);
    };
  }
}

afterAll(() => {
  const attempts = (registry[KEY] as SeedGuard).take();
  if (attempts.length > 0) throw new Error(`seed guard: this file tried to write the repository's own map: ${attempts.join("; ")}`);
});
