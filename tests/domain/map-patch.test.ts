import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { structureWithMarkers } from "../../src/agent/fake-provider";
import { makeId, slugify } from "../../src/domain/ids";
import {
  applyMapPatch,
  describePatch,
  resolveProposal,
  type AgentOutput,
  type MapPatch,
} from "../../src/domain/map-patch";
import { approveRevision, setCardRow, updateCard } from "../../src/domain/operations";
import type { ProductDocument } from "../../src/domain/schema";
import { exportProductYaml, parseProductText } from "../../src/domain/serialize";
import { loadFixture } from "./helpers";

export const TRANSCRIPT = readFileSync(
  path.join(__dirname, "..", "fixtures", "workshop-transcript.txt"),
  "utf8",
);

const QUOTE = "Before anything is exported I want the team to read the slice against the narrative once.";
const source = { snippet: QUOTE, rationale: "Jonas asked for it.", confidence: 0.8 };

function emptyOutput(): AgentOutput {
  return { summary: "", goal: null, personas: [], needs: [], steps: [], assignments: [], moves: [], unresolvedQuestions: [] };
}

function proposal(product: ProductDocument, output: unknown) {
  return resolveProposal(product, output, TRANSCRIPT, "test");
}

function fixturePatch(product = loadFixture()): MapPatch {
  const result = proposal(product, structureWithMarkers(TRANSCRIPT, product));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.patch;
}

function accept(product: ProductDocument, patch: MapPatch): ProductDocument {
  const result = applyMapPatch(product, patch);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.product;
}

const codes = (result: { ok: boolean; issues?: { code: string }[] }) => (result.issues ?? []).map((i) => i.code);

describe("proposal from the workshop fixture", () => {
  it("resolves to the expected operations with deterministic ids", () => {
    const patch = fixturePatch();
    expect(patch.operations.map((o) => o.op)).toEqual([
      "add_persona",
      "add_need",
      "add_step",
      "assign_persona",
      "add_question",
      "add_question",
      "add_question",
    ]);
    expect(patch.operations.map((o) => ("id" in o ? o.id : null))).toEqual([
      "persona-support-lead",
      `need-${slugify("Trace a customer problem back to the narrative step it belongs to.")}`,
      "step-walk-through-the-slice-with-the-team",
      null,
      `dec-${slugify("Should support be able to reopen an approved narrative?")}`,
      `dec-${slugify("Who owns the map after the first slice has shipped?")}`,
      expect.stringMatching(/^dec-whose-need-is-this/),
    ]);
    expect(fixturePatch()).toEqual(patch);
  });

  it("derives ids from text and resolves collisions with a numeric suffix", () => {
    const taken = new Set(["persona-developer"]);
    expect(makeId("persona", "Développeur Senior!", new Set())).toBe("persona-developpeur-senior");
    expect(makeId("persona", "Developer", taken)).toBe("persona-developer-2");
    expect(makeId("persona", "Developer", taken)).toBe("persona-developer-3");
    expect(makeId("step", "???", new Set())).toBe("step-item");
  });

  it("describes every operation in plain language", () => {
    const product = loadFixture();
    expect(describePatch(product, fixturePatch(product)).map((e) => e.headline)).toEqual([
      "Add persona “Support Lead”",
      "Add a need for “Support Lead”",
      "Add step “Walk through the slice with the team” after “Human selects first slice”, for “Developer”, “Support Lead”",
      "Assign “Support Lead” to step “Review gaps and unresolved decisions”",
      "Unresolved question (becomes an open decision)",
      "Unresolved question (becomes an open decision)",
      "Unresolved question (becomes an open decision)",
    ]);
  });
});

describe("invalid model output cannot become a proposal", () => {
  const product = loadFixture();
  const cases: [string, unknown][] = [
    ["a string", "I have approved the map."],
    ["null", null],
    ["an array", []],
    ["missing fields", { summary: "x" }],
    ["a wrong type", { ...emptyOutput(), personas: "Support Lead" }],
    ["an extra top-level field", { ...emptyOutput(), approve: true }],
    ["an extra nested field", { ...emptyOutput(), goal: { statement: "x", source, status: "approved" } }],
  ];
  it.each(cases)("rejects %s", (_name, output) => {
    const result = proposal(product, output);
    expect(result.ok).toBe(false);
    expect(codes(result).every((c) => c.startsWith("agent_output_"))).toBe(true);
  });

  it("rejects an empty proposal", () => {
    expect(codes(proposal(product, emptyOutput()))).toEqual(["empty_proposal"]);
  });

  it("rejects empty text, out-of-range confidence and over-long text", () => {
    const output = emptyOutput();
    output.personas.push({ ref: "new:a", name: "  ", description: "x".repeat(601), source: { ...source, confidence: 1.5 } });
    expect(codes(proposal(product, output)).sort()).toEqual(["empty_text", "invalid_confidence", "text_too_long"]);
  });

  it("rejects a snippet that does not occur in the pasted text", () => {
    const output = emptyOutput();
    output.personas.push({
      ref: "new:a",
      name: "Auditor",
      description: "",
      source: { snippet: "Everyone agreed we need an auditor.", rationale: "", confidence: 1 },
    });
    expect(codes(proposal(product, output))).toEqual(["snippet_not_in_source"]);
  });

  it("applyMapPatch refuses anything that is not a MapPatch and returns no document", () => {
    for (const bad of [null, "approve", {}, { ...fixturePatch(), revision: { status: "approved" } }]) {
      const result = applyMapPatch(product, bad);
      expect(result.ok).toBe(false);
      expect("product" in result).toBe(false);
    }
  });

  it("the patch schema has no operation that approves, decides or deletes", () => {
    const patch = fixturePatch();
    for (const op of ["approve", "approve_revision", "set_status", "decide", "delete_persona", "remove_step"]) {
      const forged = { ...patch, operations: [{ ...patch.operations[0], op }] };
      expect(applyMapPatch(product, forged).ok).toBe(false);
    }
    const decided = { ...patch, operations: [{ ...patch.operations[4], status: "decided" }] };
    expect(applyMapPatch(product, decided).ok).toBe(false);
  });
});

describe("unknown ids are rejected", () => {
  const product = loadFixture();

  it("in agent output: unknown persona, need, step and undeclared ref", () => {
    const output = emptyOutput();
    output.needs.push({ ref: "new:n", persona: "persona-ghost", statement: "A need", source });
    output.steps.push({
      ref: "new:s",
      title: "A step",
      description: "",
      personas: ["new:nobody"],
      needs: ["need-ghost"],
      placement: { kind: "after", step: "step-ghost" },
      source,
    });
    output.assignments.push({ step: "step-ghost", persona: "persona-developer", source });
    output.moves.push({ step: "step-ghost", placement: { kind: "end", step: null }, source });
    output.unresolvedQuestions.push({ question: "Why?", relatesTo: ["nothing-here"], source });
    const result = proposal(product, output);
    expect(result.ok).toBe(false);
    expect(codes(result).sort()).toEqual([
      "unknown_id",
      "unknown_id",
      "unknown_id",
      "unknown_id",
      "unknown_id",
      "unknown_id",
      "unknown_ref",
    ]);
  });

  it("in agent output: an id of the wrong kind is unknown for that slot", () => {
    const output = emptyOutput();
    output.needs.push({ ref: "new:n", persona: "step-start-product", statement: "A need", source });
    expect(codes(proposal(product, output))).toEqual(["unknown_id"]);
  });

  it("in agent output: a self-chosen id is not accepted as a ref", () => {
    const output = emptyOutput();
    output.personas.push({ ref: "persona-my-own-id", name: "Auditor", description: "", source });
    expect(codes(proposal(product, output))).toEqual(["invalid_ref"]);
  });

  it("in a patch: unknown persona, step and relation", () => {
    const patch = fixturePatch(product);
    const edit = (index: number, change: object): MapPatch => ({
      ...patch,
      operations: patch.operations.map((o, i) => (i === index ? ({ ...o, ...change } as typeof o) : o)),
    });
    expect(codes(applyMapPatch(product, edit(1, { personaId: "persona-ghost" })))).toEqual(["unknown_id"]);
    expect(codes(applyMapPatch(product, edit(3, { stepId: "step-ghost" })))).toEqual(["unknown_id"]);
    expect(codes(applyMapPatch(product, edit(2, { placement: { kind: "after", stepId: "step-ghost" } })))).toEqual(["unknown_id"]);
    expect(codes(applyMapPatch(product, edit(4, { relatesTo: ["nothing-here"] })))).toEqual(["unknown_id"]);
  });

  it("in a patch: ids must follow the convention and must be new", () => {
    const patch = fixturePatch(product);
    const withId = (id: string): MapPatch => ({
      ...patch,
      operations: [{ ...patch.operations[0], id } as MapPatch["operations"][number]],
    });
    expect(codes(applyMapPatch(product, withId("support-lead")))).toEqual(["id_convention"]);
    expect(codes(applyMapPatch(product, withId("persona-developer")))).toEqual(["duplicate_id"]);
    expect(applyMapPatch(product, withId("Persona Support")).ok).toBe(false);
  });
});

describe("acceptance changes only what was proposed", () => {
  const before = loadFixture();
  const patch = fixturePatch(before);
  const after = accept(before, patch);

  it("does not mutate the input document", () => {
    expect(before).toEqual(loadFixture());
  });

  it("yields the next proposed revision and never an approved one", () => {
    expect(after.revision).toEqual({ number: 2, status: "proposed" });
    const approved = approveRevision(before, { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" });
    expect(accept(approved, fixturePatch(approved)).revision).toEqual({ number: 2, status: "proposed" });
  });

  it("leaves everything that was not proposed exactly as it was", () => {
    expect(after.product).toEqual(before.product);
    expect(after.goal).toEqual(before.goal);
    expect(after.wcbc).toEqual(before.wcbc);
    expect(after.layout).toEqual(before.layout);
    expect(after.personas.slice(0, before.personas.length)).toEqual(before.personas);
    expect(after.needs.slice(0, before.needs.length)).toEqual(before.needs);
    expect(after.decisions.slice(0, before.decisions.length)).toEqual(before.decisions);

    for (const step of before.narrative) {
      const now = after.narrative.find((s) => s.id === step.id)!;
      const expectedPersonas =
        step.id === "step-review-gaps" ? [...step.personaIds, "persona-support-lead"] : step.personaIds;
      const expectedSequence = step.id === "step-export-work" ? 12 : step.sequence;
      expect(now).toEqual({ ...step, personaIds: expectedPersonas, sequence: expectedSequence });
    }
  });

  it("adds exactly the proposed items", () => {
    expect(after.personas.slice(before.personas.length)).toEqual([
      {
        id: "persona-support-lead",
        name: "Support Lead",
        description: "Hears first when a delivered slice does not match what users expected.",
      },
    ]);
    expect(after.needs.slice(before.needs.length).map((n) => [n.personaId, n.statement])).toEqual([
      ["persona-support-lead", "Trace a customer problem back to the narrative step it belongs to."],
    ]);
    expect(after.narrative.find((s) => s.id === "step-walk-through-the-slice-with-the-team")).toEqual({
      id: "step-walk-through-the-slice-with-the-team",
      sequence: 11,
      title: "Walk through the slice with the team",
      description: "The team reads the selected slice against the narrative before it is exported.",
      personaIds: ["persona-developer", "persona-support-lead"],
      needIds: [],
    });
    expect(after.narrative).toHaveLength(12);
  });

  it("turns unresolved questions into open decisions, never decided ones", () => {
    const added = after.decisions.slice(before.decisions.length);
    expect(added).toHaveLength(3);
    expect(added.every((d) => d.status === "open" && d.rationale === "")).toBe(true);
  });

  it("a goal change replaces only the goal statement", () => {
    const output = emptyOutput();
    output.goal = { statement: "A sharper goal.", source };
    const result = proposal(before, output);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const changed = accept(before, result.patch);
    expect(changed.goal).toEqual({ id: before.goal.id, statement: "A sharper goal." });
    expect({ ...changed, goal: before.goal, revision: before.revision, provenance: [] }).toEqual(before);
  });

  it("a suggested move changes the order and nothing else", () => {
    const output = emptyOutput();
    output.moves.push({ step: "step-define-personas", placement: { kind: "start", step: null }, source });
    const result = proposal(before, output);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const moved = accept(before, result.patch);
    const order = (p: ProductDocument) => [...p.narrative].sort((a, b) => a.sequence - b.sequence).map((s) => s.id);
    expect(order(moved).slice(0, 4)).toEqual([
      "step-define-personas",
      "step-start-product",
      "step-describe-idea",
      "step-confirm-intent",
    ]);
    const strip = (p: ProductDocument) =>
      p.narrative.map(({ sequence: _s, ...rest }) => rest).sort((a, b) => a.id.localeCompare(b.id));
    expect(strip(moved)).toEqual(strip(before));
    expect({ ...moved, narrative: [], revision: before.revision, provenance: [] }).toEqual({ ...before, narrative: [] });
  });

  it("confidence is advisory: it changes nothing but the recorded confidence", () => {
    const withConfidence = (value: number): MapPatch => ({
      ...patch,
      operations: patch.operations.map((o) => ({ ...o, source: { ...o.source, confidence: value } })),
    });
    const low = accept(before, withConfidence(0));
    const high = accept(before, withConfidence(1));
    const strip = (p: ProductDocument) => ({ ...p, provenance: p.provenance.map(({ confidence: _c, ...rest }) => rest) });
    expect(strip(low)).toEqual(strip(high));
  });
});

describe("source and rationale survive into the accepted revision", () => {
  const before = loadFixture();
  const patch = fixturePatch(before);
  const after = accept(before, patch);

  it("records one provenance entry per accepted operation", () => {
    expect(after.provenance).toHaveLength(patch.operations.length);
    expect(after.provenance.map((p) => [p.targetId, p.change])).toEqual([
      ["persona-support-lead", "added"],
      [expect.stringMatching(/^need-trace-a-customer-problem/), "added"],
      ["step-walk-through-the-slice-with-the-team", "added"],
      ["step-review-gaps", "assigned"],
      [expect.stringMatching(/^dec-should-support/), "added"],
      [expect.stringMatching(/^dec-who-owns-the-map/), "added"],
      [expect.stringMatching(/^dec-whose-need-is-this/), "added"],
    ]);
  });

  it("keeps the verbatim snippet, the rationale, the provider and the revision", () => {
    const entry = after.provenance.find((p) => p.targetId === "step-walk-through-the-slice-with-the-team")!;
    expect(TRANSCRIPT).toContain(entry.snippet);
    expect(entry.snippet).toMatch(/^Step: Walk through the slice with the team/);
    expect(entry).toMatchObject({
      rationale: "Stated explicitly in the discussion.",
      confidence: 1,
      provider: "test",
      revision: 2,
    });
  });

  it("survives export and re-import of the canonical file", () => {
    const reloaded = parseProductText(exportProductYaml(after));
    expect(reloaded.ok && reloaded.product.provenance).toEqual(after.provenance);
  });

  it("survives later edits and accumulates across proposals", () => {
    const edited = updateCard(after, "persona-support-lead", { name: "Head of Support" });
    expect(edited.provenance).toEqual(after.provenance);

    const output = emptyOutput();
    output.goal = { statement: "A sharper goal.", source };
    const second = proposal(edited, output);
    if (!second.ok) throw new Error(JSON.stringify(second.issues));
    const twice = accept(edited, second.patch);
    expect(twice.provenance).toHaveLength(after.provenance.length + 1);
    expect(twice.provenance.at(-1)).toMatchObject({ targetId: before.goal.id, change: "changed", snippet: QUOTE, revision: 3 });
  });

  it("provenance pointing at a missing element is invalid", () => {
    const broken = { ...after, personas: after.personas.filter((p) => p.id !== "persona-support-lead") };
    const result = parseProductText(exportProductYaml(broken as ProductDocument));
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("unknown_provenance_target");
  });
});

describe("a proposal is bound to the map it was made for", () => {
  it("is refused once the meaning of the map has changed", () => {
    const before = loadFixture();
    const patch = fixturePatch(before);
    const changed = updateCard(before, "step-start-product", { title: "Begin" });
    expect(codes(applyMapPatch(changed, patch))).toEqual(["stale_patch"]);
  });

  it("is still valid after a purely visual change", () => {
    const before = loadFixture();
    const patch = fixturePatch(before);
    expect(applyMapPatch(setCardRow(before, "step-start-product", 2), patch).ok).toBe(true);
  });

  it("cannot be accepted twice", () => {
    const before = loadFixture();
    const patch = fixturePatch(before);
    expect(codes(applyMapPatch(accept(before, patch), patch))).toEqual(["stale_patch"]);
  });
});

describe("human edits to a proposal before accepting", () => {
  const before = loadFixture();
  const patch = fixturePatch(before);

  it("edited text is what gets accepted; ids stay as proposed", () => {
    const edited: MapPatch = {
      ...patch,
      operations: patch.operations.map((o) => (o.op === "add_step" ? { ...o, title: "Team read-through" } : o)),
    };
    const after = accept(before, edited);
    expect(after.narrative.find((s) => s.id === "step-walk-through-the-slice-with-the-team")?.title).toBe(
      "Team read-through",
    );
  });

  it("dropping operations accepts only the rest", () => {
    const onlyQuestion: MapPatch = { ...patch, operations: patch.operations.filter((o) => o.opId === "op-6") };
    const after = accept(before, onlyQuestion);
    expect(after.personas).toEqual(before.personas);
    expect(after.narrative).toEqual(before.narrative);
    expect(after.decisions).toHaveLength(before.decisions.length + 1);
    expect(after.provenance).toHaveLength(1);
  });

  it("dropping something others depend on is refused, not silently repaired", () => {
    const withoutPersona: MapPatch = { ...patch, operations: patch.operations.filter((o) => o.op !== "add_persona") };
    const result = applyMapPatch(before, withoutPersona);
    expect(result.ok).toBe(false);
    expect(new Set(codes(result))).toEqual(new Set(["unknown_id"]));
  });

  it("accepting nothing is refused", () => {
    expect(codes(applyMapPatch(before, { ...patch, operations: [] }))).toEqual(["empty_patch"]);
  });
});
