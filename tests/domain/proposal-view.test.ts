import { describe, expect, it } from "vitest";
import { structureWithMarkers } from "../../src/agent/fake-provider";
import { blankProduct } from "../../src/domain/bootstrap";
import { applyMapPatch, resolveProposal, type MapPatch } from "../../src/domain/map-patch";
import { goalChoice, groupProposal, suggestionsFor } from "../../src/domain/proposal-view";
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
