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
  // Both spellings of a handler export, so a GET written as a const is not a way around the check (external review F6).
  const GET_EXPORT = /export (?:async function|const|function) GET\b|export \{[^}]*\bGET\b[^}]*\}/;
  const readers = files.filter((file) => GET_EXPORT.test(readFileSync(file, "utf8")));

  it("the guard recognises a handler written as a const as well", () => {
    expect(GET_EXPORT.test("export const GET = async () => {}")).toBe(true);
    expect(GET_EXPORT.test("export async function GET(request: Request) {")).toBe(true);
    expect(GET_EXPORT.test("export function GET() {")).toBe(true);
    expect(GET_EXPORT.test("export { handler as GET };")).toBe(true);
    expect(GET_EXPORT.test("export { GET };")).toBe(true);
  });

  it("an aliased GET whose handler writes somewhere above the export clause is caught", () => {
    const sample = ["import { saveProduct } from \"../../../server/store\";", "async function handler() { await saveProduct({}); return Response.json({}); }", "export { handler as GET };"].join("\n");
    const aliased = /export \{[^}]*\bGET\b[^}]*\}/.test(sample);
    const start = sample.search(GET_EXPORT);
    const body = aliased ? sample : sample.slice(start);
    expect(WRITERS.test(body)).toBe(true);
    expect(WRITERS.test(sample.slice(start))).toBe(false);
  });

  it("finds the readers", () => {
    expect(readers.map((f) => path.relative(API, f)).sort()).toEqual(["brief/route.ts", "product/route.ts", "slices/route.ts"]);
  });

  it("no GET handler imports or calls anything that writes a file", () => {
    for (const file of readers) {
      const source = readFileSync(file, "utf8");
      // product/route.ts also exports PUT, which saves: only its GET body is checked.
      const start = source.search(GET_EXPORT);
      const rest = source.slice(start + 1).search(/export (?:async function|const|function) /);
      // A handler exported under an alias has its body somewhere else in the file: then the whole file is the body.
      const aliased = /export \{[^}]*\bGET\b[^}]*\}/.test(source);
      const body = aliased ? source : source.slice(start, rest === -1 ? undefined : start + 1 + rest);
      expect(WRITERS.test(body), `${path.relative(API, file)}: GET body`).toBe(false);
      expect(/\b(selectSlice|confirmPersonaCheck|acceptValueException|approveRevision)\b/.test(body), `${path.relative(API, file)}: GET body`).toBe(false);
      if (!source.includes("export async function PUT") && !source.includes("export async function POST"))
        expect(/import .*\b(saveWorkState|saveProduct|createProduct|selectSlice|confirmPersonaCheck)\b/.test(source), `${path.relative(API, file)}: imports`).toBe(false);
    }
  });
});
