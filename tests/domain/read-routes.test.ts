import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A read never writes. Every route that answers GET is a projection: it may
 * derive candidates, findings or a work order, and it may not touch the
 * product file or the work-state file. A GET handler that selected a slice,
 * confirmed a check or saved a document would make a human gate disappear
 * without any request a human made; this check refuses such code before any
 * behaviour test has to catch it.
 */
const API = path.join(__dirname, "..", "..", "src", "app", "api");
const WRITERS = /\b(saveWorkState|saveProduct|createProduct|writeFile|rename|link|rm|unlink|mkdir)\b/;

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? routes(path.join(dir, entry.name)) : entry.name === "route.ts" ? [path.join(dir, entry.name)] : [],
  );
}

describe("routes that answer GET only read", () => {
  const files = routes(API);
  const readers = files.filter((file) => /export async function GET\b/.test(readFileSync(file, "utf8")));

  it("finds the readers", () => {
    expect(readers.map((f) => path.relative(API, f)).sort()).toEqual(["brief/route.ts", "product/route.ts", "slices/route.ts"]);
  });

  it("no GET handler imports or calls anything that writes a file", () => {
    for (const file of readers) {
      const source = readFileSync(file, "utf8");
      // product/route.ts also exports PUT, which saves: only its GET body is checked.
      const start = source.indexOf("export async function GET");
      const end = source.indexOf("export async function", start + 1);
      const body = source.slice(start, end === -1 ? undefined : end);
      expect(WRITERS.test(body), `${path.relative(API, file)}: GET body`).toBe(false);
      expect(/\b(selectSlice|confirmPersonaCheck|acceptValueException|approveRevision)\b/.test(body), `${path.relative(API, file)}: GET body`).toBe(false);
      if (!source.includes("export async function PUT") && !source.includes("export async function POST"))
        expect(/import .*\b(saveWorkState|saveProduct|createProduct|selectSlice|confirmPersonaCheck)\b/.test(source), `${path.relative(API, file)}: imports`).toBe(false);
    }
  });
});
