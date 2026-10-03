import { describe, expect, it } from "vitest";
import { structureWithMarkers } from "../../src/agent/fake-provider";
import {
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_SOURCES,
  bundleFromTranscript,
  validateContextBundle,
  type ContextBundle,
} from "../../src/domain/context";
import { applyMapPatch, resolveProposal } from "../../src/domain/map-patch";
import { validateProduct } from "../../src/domain/validate";
import { loadFixture } from "./helpers";

const codes = (result: { ok: boolean; issues?: { code: string }[] }) => (result.issues ?? []).map((i) => i.code);
const source = (id: string, text: string, extra: Partial<{ label: string; kind: "pasted" | "file" }> = {}) => ({
  id,
  label: extra.label ?? `${id}.txt`,
  kind: extra.kind ?? ("file" as const),
  text,
});

/**
 * ASM-24: the context a proposal is built from is a bundle of sources, each with
 * a stable transient identity. Validation is the only gate before a provider sees
 * it; provenance has to name the source a snippet came from, and the snippet has
 * to occur in that source.
 */
describe("context bundle validation", () => {
  it("accepts pasted text and text/markdown files, each with an id and a label", () => {
    const result = validateContextBundle({
      sources: [
        { id: "src-1", label: "Pasted text", kind: "pasted", text: "Goal: Something." },
        { id: "src-2", label: "notes.md", kind: "file", text: "# Notes\nPersona: Resident" },
        { id: "src-3", label: "transcript.TXT", kind: "file", text: "Need (Resident): A parcel." },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.bundle.sources.map((s) => s.id)).toEqual(["src-1", "src-2", "src-3"]);
  });

  it("a plain transcript string is one pasted source, so every older caller keeps working", () => {
    const bundle = bundleFromTranscript("Goal: Something.");
    expect(bundle).toEqual({ sources: [{ id: "src-1", label: "Pasted text", kind: "pasted", text: "Goal: Something." }] });
    expect(validateContextBundle(bundle).ok).toBe(true);
  });

  it.each<[string, unknown, string]>([
    ["no sources at all", { sources: [] }, "empty_context"],
    ["not an object", "Goal: x", "context_invalid_type"],
    ["a source with only whitespace", { sources: [source("src-1", " \n\t ")] }, "empty_source"],
    ["an unsupported file type", { sources: [source("src-1", "x", { label: "deck.pdf" })] }, "unsupported_type"],
    ["a file without an extension", { sources: [source("src-1", "x", { label: "README" })] }, "unsupported_type"],
    ["binary content (a NUL byte)", { sources: [source("src-1", "Goal: x\u0000y")] }, "binary_content"],
    ["an id that is not src-N", { sources: [source("hello", "x")] }, "context_invalid_format"],
    ["two sources with the same id", { sources: [source("src-1", "x"), source("src-1", "y")] }, "duplicate_source_id"],
    ["a label that is empty", { sources: [source("src-1", "x", { label: " ", kind: "pasted" })] }, "context_too_small"],
    ["an unknown kind", { sources: [{ id: "src-1", label: "x", kind: "pdf", text: "x" }] }, "context_invalid_value"],
    ["an extra field", { sources: [{ ...source("src-1", "x"), path: "/etc/passwd" }] }, "context_unrecognized_keys"],
  ])("refuses %s", (_name, input, code) => {
    const result = validateContextBundle(input);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(code);
  });

  it("limits: one source over the limit, the bundle over the limit in total, too many sources", () => {
    const big = "x".repeat(MAX_CONTEXT_CHARS + 1);
    expect(codes(validateContextBundle({ sources: [source("src-1", big)] }))).toEqual(["source_too_large"]);

    const half = "y".repeat(Math.ceil(MAX_CONTEXT_CHARS / 2) + 1);
    expect(codes(validateContextBundle({ sources: [source("src-1", half), source("src-2", half)] }))).toEqual(["context_too_large"]);

    const many = Array.from({ length: MAX_CONTEXT_SOURCES + 1 }, (_, i) => source(`src-${i + 1}`, `line ${i}`));
    expect(codes(validateContextBundle({ sources: many }))).toEqual(["too_many_sources"]);
    expect(validateContextBundle({ sources: many.slice(0, MAX_CONTEXT_SOURCES) }).ok).toBe(true);
  });
});

describe("provenance across sources", () => {
  const product = loadFixture();
  const notes = "Persona: Courier — Delivers parcels. [roles: operator]";
  const transcript = "Goal: Residents collect parcels independently.";
  const bundle: ContextBundle = {
    sources: [
      { id: "src-1", label: "Pasted text", kind: "pasted", text: transcript },
      { id: "src-2", label: "notes.md", kind: "file", text: notes },
    ],
  };
  const output = (sourceId?: string, snippet = notes) => ({
    summary: "",
    goal: null,
    personas: [
      {
        ref: "new:courier",
        name: "Courier",
        description: "Delivers parcels.",
        roles: ["operator"],
        persona: true,
        source: { snippet, rationale: "Stated.", confidence: 1, ...(sourceId ? { sourceId } : {}) },
      },
    ],
    needs: [],
    steps: [],
    assignments: [],
    moves: [],
    unresolvedQuestions: [],
  });

  it("the fake provider stamps every item with the id of the source its line came from", () => {
    const out = structureWithMarkers(bundle, product);
    expect(out.goal?.source.sourceId).toBe("src-1");
    expect(out.personas[0].source.sourceId).toBe("src-2");
  });

  it("a snippet from the named source is accepted, and the provenance records which source", () => {
    const result = resolveProposal(product, output("src-2"), bundle, "test");
    expect(result.ok).toBe(true);
    const op = result.ok ? result.patch.operations[0] : null;
    expect(op?.source).toMatchObject({ sourceId: "src-2", sourceLabel: "notes.md" });

    const applied = result.ok ? applyMapPatch(product, result.patch) : null;
    expect(applied?.ok).toBe(true);
    const record = applied?.ok ? applied.product.provenance.at(-1) : null;
    expect(record).toMatchObject({ targetId: "persona-courier", sourceId: "src-2", sourceLabel: "notes.md" });
    // What was written is a valid product; nothing about the new fields breaks the schema.
    expect(applied?.ok && validateProduct(applied.product).ok).toBe(true);
  });

  it("a snippet quoted against the wrong source is refused, even though it occurs in another source", () => {
    const result = resolveProposal(product, output("src-1"), bundle, "test");
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["snippet_not_in_source"]);
  });

  it("a source id the bundle does not have is refused", () => {
    const result = resolveProposal(product, output("src-9"), bundle, "test");
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["unknown_source"]);
  });

  it("with several sources an item has to say which one; with one source it is implied", () => {
    const several = resolveProposal(product, output(undefined), bundle, "test");
    expect(several.ok).toBe(false);
    expect(codes(several)).toEqual(["source_required"]);

    const one: ContextBundle = { sources: [bundle.sources[1]] };
    const single = resolveProposal(product, output(undefined), one, "test");
    expect(single.ok).toBe(true);
    expect(single.ok && single.patch.operations[0].source).toMatchObject({ sourceId: "src-2", sourceLabel: "notes.md" });
  });

  it("a snippet that spans the boundary between two sources is in neither and is refused", () => {
    const spanning = `${transcript.slice(-12)} ${notes.slice(0, 12)}`;
    for (const id of ["src-1", "src-2"]) {
      const result = resolveProposal(product, output(id, spanning), bundle, "test");
      expect(result.ok).toBe(false);
      expect(codes(result)).toEqual(["snippet_not_in_source"]);
    }
  });

  it("a map written before source ids existed still validates, and so does one with them", () => {
    const old = loadFixture();
    expect(validateProduct(old).ok).toBe(true);
    const withIds = structuredClone(old);
    withIds.provenance.push({
      targetId: old.goal.id,
      change: "changed",
      snippet: "x",
      rationale: "",
      confidence: 0.5,
      provider: "test",
      revision: 1,
      sourceId: "src-2",
      sourceLabel: "notes.md",
    });
    expect(validateProduct(withIds).ok).toBe(true);
  });
});
