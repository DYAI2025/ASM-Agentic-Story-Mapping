import { describe, expect, it } from "vitest";
import { structureWithMarkers } from "../../src/agent/fake-provider";
import { blankProduct } from "../../src/domain/bootstrap";
import { applyMapPatch, resolveProposal, type MapPatch } from "../../src/domain/map-patch";
import { goalChoice, goalChoiceOpen, groupProposal, suggestionsFor } from "../../src/domain/proposal-view";
import { loadFixture } from "./helpers";

/**
 * ASM-26: the human reviews product meaning, grouped, not a list of patch
 * operations. Alternatives for the goal are a choice the human makes; nothing
 * is chosen for them. Suggestions only ever fill a draft field.
 */
const TEXT = [
  "Goal: Residents collect a parcel without waiting for a courier.",
  "Persona: Resident — Lives in the building. [roles: customer, user]",
  "Persona: Courier — Delivers for several carriers. [roles: operator]",
  "Actor: Building manager — Owns the lobby. [roles: stakeholder]",
  "Need (Resident): Get my parcel on the day it arrives.",
  "Need (Courier): Drop a parcel in under a minute.",
  "Step: Courier loads the parcel — Into a free compartment. [personas: Courier] [needs: Drop a parcel in under a minute]",
  "Step: Resident opens the compartment — With the code. [personas: Resident] [needs: Get my parcel on the day it arrives]",
  "Do oversized parcels go somewhere else?",
].join("\n");

const codes = (result: { ok: boolean; issues?: { code: string }[] }) => (result.issues ?? []).map((i) => i.code);

function proposal(text = TEXT) {
  const blank = blankProduct("Parcel lockers");
  if (!blank.ok) throw new Error("blank");
  const result = resolveProposal(blank.product, structureWithMarkers(text, blank.product), text, "test");
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return { product: blank.product, patch: result.patch };
}

describe("grouping a proposal into product meaning", () => {
  it("sections in reading order, each entry in exactly one, op ids untouched", () => {
    const { product, patch } = proposal();
    const sections = groupProposal(product, patch);
    expect(sections.map((s) => s.group)).toEqual(["goal", "personas", "actors", "needs", "path", "questions"]);
    expect(sections.map((s) => s.title)).toEqual([
      "Goal",
      "Personas",
      "Other actors and roles",
      "Needs",
      "Suggested main path",
      "Open questions",
    ]);
    const opIds = sections.flatMap((s) => s.entries.map((e) => e.opId));
    expect(opIds.sort()).toEqual(patch.operations.map((o) => o.opId).sort());
    expect(new Set(opIds).size).toBe(opIds.length);
    expect(sections.find((s) => s.group === "personas")!.entries.map((e) => e.headline)).toEqual(["Add persona “Resident”", "Add persona “Courier”"]);
    expect(sections.find((s) => s.group === "actors")!.entries).toHaveLength(1);
    expect(sections.find((s) => s.group === "needs")!.entries).toHaveLength(2);
    expect(sections.find((s) => s.group === "path")!.entries.map((e) => e.op)).toEqual(["add_step", "add_step"]);
    expect(sections.find((s) => s.group === "questions")!.entries[0].after).toBe("Do oversized parcels go somewhere else?");
  });

  it("empty sections are left out; moves, assignments and worst cases go to the path or to other changes", () => {
    const product = loadFixture();
    const text = ["Assign: Developer -> Start product", "Move: Export execution-ready work -> start"].join("\n");
    const result = resolveProposal(product, structureWithMarkers(text, product), text, "test");
    expect(result.ok).toBe(true);
    const sections = groupProposal(product, result.ok ? result.patch : ({} as MapPatch));
    expect(sections.map((s) => s.group)).toEqual(["path"]);
    expect(sections[0].entries.map((e) => e.op)).toEqual(["assign_persona", "move_step"]);
  });
});

describe("alternatives for the goal are a human choice", () => {
  const TWO_GOALS = [TEXT, "Goal: Couriers deliver to the building in one stop."].join("\n");

  it("the fake provider turns a second Goal line into an alternative, and the proposal carries both as a choice", () => {
    const blank = blankProduct("Parcel lockers");
    if (!blank.ok) throw new Error("blank");
    const out = structureWithMarkers(TWO_GOALS, blank.product);
    expect(out.goal?.statement).toBe("Residents collect a parcel without waiting for a courier.");
    expect(out.goalAlternatives).toHaveLength(1);
    expect(out.goalAlternatives?.[0].statement).toBe("Couriers deliver to the building in one stop.");

    const result = resolveProposal(blank.product, out, TWO_GOALS, "test");
    expect(result.ok).toBe(true);
    const goals = result.ok ? result.patch.operations.filter((o) => o.op === "set_goal") : [];
    expect(goals).toHaveLength(2);
    expect(goals.every((o) => o.op === "set_goal" && o.choice === "goal")).toBe(true);
    // The alternative comes last, so every other op keeps the id it had without it.
    const { patch: single } = proposal();
    const withAlternative = result.ok ? result.patch : ({} as MapPatch);
    expect(withAlternative.operations.slice(0, single.operations.length).map((o) => [o.opId, o.op])).toEqual(single.operations.map((o) => [o.opId, o.op]));
    expect(goalChoice(withAlternative).map((o) => o.statement)).toEqual([
      "Residents collect a parcel without waiting for a courier.",
      "Couriers deliver to the building in one stop.",
    ]);
    expect(goalChoice(single)).toEqual([]);
  });

  it("a patch that still holds two goals cannot be applied: nothing picks one silently", () => {
    const blank = blankProduct("Parcel lockers");
    if (!blank.ok) throw new Error("blank");
    const result = resolveProposal(blank.product, structureWithMarkers(TWO_GOALS, blank.product), TWO_GOALS, "test");
    const patch = result.ok ? result.patch : ({} as MapPatch);
    const applied = applyMapPatch(blank.product, patch);
    expect(applied.ok).toBe(false);
    expect(codes(applied)).toEqual(["conflicting_goal"]);

    // With exactly one of them kept, either applies, and the goal is the one kept.
    for (const keep of patch.operations.filter((o) => o.op === "set_goal")) {
      const chosen = { ...patch, operations: patch.operations.filter((o) => o.op !== "set_goal" || o.opId === keep.opId) };
      const one = applyMapPatch(blank.product, chosen);
      expect(one.ok).toBe(true);
      expect(one.ok && one.product.goal.statement).toBe(keep.op === "set_goal" ? keep.statement : "");
    }
    // With none kept on a first product there is no goal, as before.
    const none = { ...patch, operations: patch.operations.filter((o) => o.op !== "set_goal") };
    expect(applyMapPatch(blank.product, none).ok).toBe(false);
  });

  it("an alternative goal is checked like every other item: its quote must occur in its source, and it needs a goal to be an alternative to", () => {
    // Found by the independent verifier on 1d44fc9: alternatives passed through unvalidated stayed green.
    const blank = blankProduct("Parcel lockers");
    if (!blank.ok) throw new Error("blank");
    const honest = structureWithMarkers(TWO_GOALS, blank.product);
    const alternative = honest.goalAlternatives![0];

    const misquoted = { ...honest, goalAlternatives: [{ ...alternative, source: { ...alternative.source, snippet: "Something nobody wrote." } }] };
    expect(codes(resolveProposal(blank.product, misquoted, TWO_GOALS, "test"))).toEqual(["snippet_not_in_source"]);

    const bundle = { sources: [{ id: "src-1", label: "Pasted text", kind: "pasted" as const, text: TWO_GOALS }, { id: "src-2", label: "b.txt", kind: "file" as const, text: "Nothing here." }] };
    const unattributed = { ...honest, goalAlternatives: [{ ...alternative, source: { ...alternative.source, sourceId: undefined } }] };
    const attributed = {
      ...unattributed,
      goal: { ...honest.goal!, source: { ...honest.goal!.source, sourceId: "src-1" } },
      personas: honest.personas.map((p) => ({ ...p, source: { ...p.source, sourceId: "src-1" } })),
      needs: honest.needs.map((n) => ({ ...n, source: { ...n.source, sourceId: "src-1" } })),
      steps: honest.steps.map((s) => ({ ...s, source: { ...s.source, sourceId: "src-1" } })),
      unresolvedQuestions: honest.unresolvedQuestions.map((q) => ({ ...q, source: { ...q.source, sourceId: "src-1" } })),
    };
    expect(codes(resolveProposal(blank.product, attributed, bundle, "test"))).toEqual(["source_required"]);

    const orphan = { ...honest, goal: null, goalAlternatives: [alternative] };
    expect(codes(resolveProposal(blank.product, orphan, TWO_GOALS, "test"))).toContain("alternative_without_goal");

    // And the honest one records where the alternative came from.
    const ok = resolveProposal(blank.product, honest, TWO_GOALS, "test");
    const last = ok.ok ? ok.patch.operations.at(-1) : null;
    expect(last?.op).toBe("set_goal");
    expect(last?.source).toMatchObject({ sourceId: "src-1", sourceLabel: "Pasted text" });
  });

  it("a model cannot smuggle a choice tag onto anything but a goal, and the schema still has no approve", () => {
    const { product, patch } = proposal();
    const tagged = { ...patch, operations: patch.operations.map((o) => (o.op === "add_persona" ? { ...o, choice: "goal" } : o)) };
    expect(applyMapPatch(product, tagged).ok).toBe(false);
  });
});

describe("suggestions fill a draft field and nothing else", () => {
  it("every editable field offers the verbatim quote; the goal also offers the other goals", () => {
    const TWO_GOALS = [TEXT, "Goal: Couriers deliver to the building in one stop."].join("\n");
    const blank = blankProduct("Parcel lockers");
    if (!blank.ok) throw new Error("blank");
    const result = resolveProposal(blank.product, structureWithMarkers(TWO_GOALS, blank.product), TWO_GOALS, "test");
    const patch = result.ok ? result.patch : ({} as MapPatch);
    const goal = patch.operations.find((o) => o.op === "set_goal")!;
    const need = patch.operations.find((o) => o.op === "add_need")!;

    expect(suggestionsFor(patch, goal, "statement")).toEqual([
      { label: "As written", text: "Goal: Residents collect a parcel without waiting for a courier." },
      { label: "Alternative", text: "Couriers deliver to the building in one stop." },
    ]);
    expect(suggestionsFor(patch, need, "statement")).toEqual([{ label: "As written", text: "Need (Resident): Get my parcel on the day it arrives." }]);
    // Never for fields that are not text the human edits.
    expect(suggestionsFor(patch, need, "personaId")).toEqual([]);
  });
});

describe("ASM-31: several goal readings need exactly one explicit choice before Accept", () => {
  const FIRST = "Teams agree on one product narrative before they plan any delivery.";
  const SECOND = "Product leads hand agents a work order they can execute without asking.";
  const WORKSHOP = [`Goal: ${FIRST}`, `Goal: ${SECOND}`, "Do we ship the export first?"].join("\n");

  function workshopProposal() {
    const product = loadFixture();
    const result = resolveProposal(product, structureWithMarkers(WORKSHOP, product), WORKSHOP, "test");
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return { product, patch: result.patch, goals: goalChoice(result.patch).map((g) => g.opId) };
  }
  const without = (patch: MapPatch, excluded: Set<string>) => ({ ...patch, operations: patch.operations.filter((o) => !excluded.has(o.opId)) });

  it("on an existing product, leaving every reading out still applies — so validity cannot be the gate, the choice is", () => {
    const { product, patch, goals } = workshopProposal();
    expect(goals).toHaveLength(2);
    const none = new Set(goals);
    // The defect QA reproduced: the old goal keeps the reduced patch valid.
    const applied = applyMapPatch(product, without(patch, none));
    expect(applied.ok).toBe(true);
    expect(applied.ok && applied.product.goal.statement).toBe(product.goal.statement);
    // The rule says the decision is still open.
    expect(goalChoiceOpen(patch, none)).toBe(true);
  });

  it("exactly one reading kept closes the choice, whichever it is; both kept or none kept leaves it open", () => {
    const { patch, goals } = workshopProposal();
    const [first, second] = goals;
    expect(goalChoiceOpen(patch, new Set([second]))).toBe(false);
    expect(goalChoiceOpen(patch, new Set([first]))).toBe(false);
    expect(goalChoiceOpen(patch, new Set())).toBe(true);
    expect(goalChoiceOpen(patch, new Set([first, second]))).toBe(true);
    // Leaving out an op that is not a goal does not count as a choice.
    const other = patch.operations.find((o) => o.op !== "set_goal")!.opId;
    expect(goalChoiceOpen(patch, new Set([first, second, other]))).toBe(true);
  });

  it("with three readings, one kept closes it and two kept do not", () => {
    const product = loadFixture();
    const text = [WORKSHOP, "Goal: Agents never change the map on their own."].join("\n");
    const result = resolveProposal(product, structureWithMarkers(text, product), text, "test");
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const [a, b, c] = goalChoice(result.patch).map((g) => g.opId);
    expect(goalChoiceOpen(result.patch, new Set([b, c]))).toBe(false);
    expect(goalChoiceOpen(result.patch, new Set([c]))).toBe(true);
    expect(goalChoiceOpen(result.patch, new Set([a, b, c]))).toBe(true);
  });

  it("one goal, or none, is no choice: nothing to decide, the rule never blocks", () => {
    const { patch: single } = proposal();
    expect(goalChoiceOpen(single, new Set())).toBe(false);
    const goal = single.operations.find((o) => o.op === "set_goal")!.opId;
    expect(goalChoiceOpen(single, new Set([goal]))).toBe(false);
    const product = loadFixture();
    const question = "Do we ship the export first?";
    const noGoal = resolveProposal(product, structureWithMarkers(question, product), question, "test");
    expect(noGoal.ok && goalChoiceOpen(noGoal.patch, new Set())).toBe(false);
  });

  it("the same rule holds on a first product: Bootstrap and Workshop share it", () => {
    const blank = blankProduct("Parcel lockers");
    if (!blank.ok) throw new Error("blank");
    const text = [TEXT, "Goal: Couriers deliver to the building in one stop."].join("\n");
    const result = resolveProposal(blank.product, structureWithMarkers(text, blank.product), text, "test");
    if (!result.ok) throw new Error("proposal");
    const goals = goalChoice(result.patch).map((g) => g.opId);
    expect(goalChoiceOpen(result.patch, new Set(goals))).toBe(true);
    expect(goalChoiceOpen(result.patch, new Set([goals[1]]))).toBe(false);
  });

  it("the domain still refuses two goals on an existing product, and the product is not touched", () => {
    const { product, patch } = workshopProposal();
    const before = JSON.stringify(product);
    const applied = applyMapPatch(product, patch);
    expect(applied.ok).toBe(false);
    expect(codes(applied)).toEqual(["conflicting_goal"]);
    expect(JSON.stringify(product)).toBe(before);
  });
});
