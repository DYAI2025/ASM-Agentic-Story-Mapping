import { describe, expect, it } from "vitest";
import { structureWithMarkers } from "../../src/agent/fake-provider";
import { buildExecutionBrief } from "../../src/domain/brief";
import { fingerprint } from "../../src/domain/fingerprint";
import { deriveGuide } from "../../src/domain/guide";
import { applyMapPatch, resolveProposal } from "../../src/domain/map-patch";
import { approveRevision, moveStep, setActorRoles, setCardRow, setPersonaPerspective, setWcbcOutcome, updateCard } from "../../src/domain/operations";
import type { ProductDocument } from "../../src/domain/schema";
import { acceptValueException, resolvePersonaCheck, resolveSelection, selectSlice, type PersonaCheck, type SliceSelection } from "../../src/domain/work-state";
import { loadFixture, mutableFixture, peopleCheck } from "./helpers";

const APPROVAL = { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" };
const EXCEPTION = { rationale: "Learning spike.", acceptedBy: "Ada", acceptedAt: "2026-10-02T10:00:00.000Z" };

/** A valid document is required for every operation; this one has no needs on the shared steps, so a need-less candidate exists. */
function needlessShared(): ProductDocument {
  const p = mutableFixture();
  for (const step of p.narrative) if (step.personaIds.length > 1) step.needIds = [];
  return p;
}

type Change = { name: string; kind: "semantic" | "layout"; apply: (p: ProductDocument) => ProductDocument };

/** Every way the meaning of a map changes in this product, and one way it does not. */
const CHANGES: Change[] = [
  { name: "goal statement edited", kind: "semantic", apply: (p) => updateCard(p, p.goal.id, { statement: "Another goal." }) },
  { name: "need statement edited", kind: "semantic", apply: (p) => updateCard(p, "need-buildable-slice", { statement: "Changed need." }) },
  { name: "step description edited", kind: "semantic", apply: (p) => updateCard(p, "step-export-work", { description: "Changed." }) },
  { name: "step moved", kind: "semantic", apply: (p) => moveStep(p, "step-export-work", -1) },
  { name: "worst case given an outcome", kind: "semantic", apply: (p) => setWcbcOutcome(p, "wcbc-no-small-slice", { kind: "termination" }) },
  { name: "person's roles stated", kind: "semantic", apply: (p) => setActorRoles(p, "persona-developer", ["user"]) },
  {
    name: "need added by an accepted proposal",
    kind: "semantic",
    apply: (p) => {
      const text = "Need (Developer): Know which slice comes next.";
      const proposal = resolveProposal(p, structureWithMarkers(text, p), text, "fake");
      if (!proposal.ok) throw new Error(JSON.stringify(proposal.issues));
      const applied = applyMapPatch(p, proposal.patch);
      if (!applied.ok) throw new Error(JSON.stringify(applied.issues));
      return applied.product;
    },
  },
  {
    name: "step added by an accepted proposal",
    kind: "semantic",
    apply: (p) => {
      const text = "Step: Celebrate — Done. [personas: Developer] [after: Export execution-ready work]";
      const proposal = resolveProposal(p, structureWithMarkers(text, p), text, "fake");
      if (!proposal.ok) throw new Error(JSON.stringify(proposal.issues));
      const applied = applyMapPatch(p, proposal.patch);
      if (!applied.ok) throw new Error(JSON.stringify(applied.issues));
      return applied.product;
    },
  },
  {
    name: "person marked as not a persona (one with no need and no step)",
    kind: "semantic",
    apply: (p) => {
      const withActor = { ...p, personas: [...p.personas, { id: "persona-sponsor", name: "Sponsor", description: "Pays." }] };
      return setPersonaPerspective(approveRevision({ ...withActor, revision: { number: p.revision.number, status: "proposed" } }, APPROVAL), "persona-sponsor", false);
    },
  },
  { name: "card moved on the layout", kind: "layout", apply: (p) => setCardRow(p, "step-main-path", 2) },
];

type State = { name: string; product: ProductDocument; check: PersonaCheck | null; selection: SliceSelection | null };

/** The states a human can be in after approval, on the fixture and on a map with a need-less candidate. */
function states(): State[] {
  const out: State[] = [];
  for (const [base, make] of [["fixture", loadFixture], ["needless", needlessShared]] as const) {
    const approved = approveRevision(make(), APPROVAL);
    out.push({ name: `${base} / approved`, product: approved, check: null, selection: null });
    const check = peopleCheck(approved);
    out.push({ name: `${base} / confirmed`, product: approved, check, selection: null });
    for (const candidateId of ["slice-outcome-thread", "slice-shared-steps"]) {
      const selection = selectSlice(approved, { candidateId, selectedBy: "Maya", selectedAt: "2026-10-02T09:00:00.000Z", mapFingerprint: fingerprint(approved), personaCheck: check });
      out.push({ name: `${base} / selected ${candidateId}`, product: approved, check, selection });
      if (!buildExecutionBrief(approved, selection).ok)
        out.push({ name: `${base} / selected ${candidateId} + exception`, product: approved, check, selection: acceptValueException(approved, selection, EXCEPTION) });
    }
  }
  return out;
}

describe("re-entry: a change of meaning invalidates what was built on the old meaning, by the existing rules", () => {
  const all = states();

  it("the grid covers approved, confirmed, selected and excepted states, exportable and not", () => {
    expect(all.length).toBeGreaterThanOrEqual(9);
    expect(all.filter((s) => buildExecutionBrief(s.product, s.selection).ok).length).toBeGreaterThan(2);
  });

  for (const change of CHANGES.filter((c) => c.kind === "semantic")) {
    it(`${change.name}: revision reopens, confirmation and selection are stale with a reason, the guide is back at approval, nothing is deleted, nothing exports`, () => {
      for (const state of all) {
        const before = { check: JSON.stringify(state.check), selection: JSON.stringify(state.selection) };
        const next = change.apply(state.product);
        expect(next.revision, `${change.name} / ${state.name}`).toEqual({ number: state.product.revision.number + 1, status: "proposed" });
        expect(fingerprint(next), `${change.name} / ${state.name}`).not.toBe(fingerprint(state.product));

        if (state.check) {
          const check = resolvePersonaCheck(next, state.check);
          expect(check.ok, `${change.name} / ${state.name}`).toBe(false);
          expect(!check.ok && check.issues[0], `${change.name} / ${state.name}`).toMatchObject({ code: "stale_persona_check" });
        }
        if (state.selection) {
          const selection = resolveSelection(next, state.selection);
          expect(selection.ok, `${change.name} / ${state.name}`).toBe(false);
          expect(!selection.ok && selection.issues[0], `${change.name} / ${state.name}`).toMatchObject({ code: "stale_selection", path: "selection.mapFingerprint" });
          expect(buildExecutionBrief(next, state.selection).ok, `${change.name} / ${state.name}`).toBe(false);
        }

        const guide = deriveGuide(next, state.selection, state.check);
        expect(guide.currentStepId, `${change.name} / ${state.name}`).toBe("approve");
        for (const id of ["people_check", "select", "work_order"] as const) expect(guide.steps.find((s) => s.id === id)!.status, `${change.name} / ${state.name}`).toBe("upcoming");
        expect(guide.impacts.find((i) => i.id === "delivery")!.reached, `${change.name} / ${state.name}`).toBe(false);
        if (state.check) expect(guide.steps.find((s) => s.id === "people_check")!.stale, `${change.name} / ${state.name}`).toBeDefined();
        if (state.selection) expect(guide.steps.find((s) => s.id === "select")!.stale, `${change.name} / ${state.name}`).toBeDefined();

        // The records themselves are untouched: stale, not deleted, not repaired.
        expect(JSON.stringify(state.check), `${change.name} / ${state.name}`).toBe(before.check);
        expect(JSON.stringify(state.selection), `${change.name} / ${state.name}`).toBe(before.selection);
      }
    });
  }

  it("a layout-only change invalidates nothing: the approval, the confirmation, the selection and the export all stand", () => {
    const change = CHANGES.find((c) => c.kind === "layout")!;
    for (const state of all) {
      const next = change.apply(state.product);
      expect(next.revision, state.name).toEqual(state.product.revision);
      expect(fingerprint(next), state.name).toBe(fingerprint(state.product));
      if (state.check) expect(resolvePersonaCheck(next, state.check).ok, state.name).toBe(true);
      if (state.selection) expect(resolveSelection(next, state.selection).ok, state.name).toBe(true);
      expect(buildExecutionBrief(next, state.selection).ok, state.name).toBe(buildExecutionBrief(state.product, state.selection).ok);
      expect(deriveGuide(next, state.selection, state.check).currentStepId, state.name).toBe(deriveGuide(state.product, state.selection, state.check).currentStepId);
    }
  });

  it("the way back is the earliest step only: approving again is not enough, confirming again is not enough, each stale record is replaced only by its own human action", () => {
    const state = all.find((s) => s.name === "fixture / selected slice-outcome-thread")!;
    const changed = updateCard(state.product, state.product.goal.id, { statement: "Another goal." });
    const approvedAgain = approveRevision(changed, { approvedBy: "Ada", approvedAt: "2026-10-03T10:00:00.000Z" });
    // Approved again: the confirmation is still the old one.
    let guide = deriveGuide(approvedAgain, state.selection, state.check);
    expect(guide.currentStepId).toBe("people_check");
    expect(resolvePersonaCheck(approvedAgain, state.check).ok).toBe(false);
    // Confirmed again: the selection is still the old one, and still stale.
    const check = peopleCheck(approvedAgain);
    guide = deriveGuide(approvedAgain, state.selection, check);
    expect(guide.currentStepId).toBe("select");
    expect(guide.steps.find((s) => s.id === "select")!.stale).toBeDefined();
    expect(resolveSelection(approvedAgain, state.selection!).ok).toBe(false);
    // Selected again: done.
    const selection = selectSlice(approvedAgain, { candidateId: "slice-outcome-thread", selectedBy: "Maya", selectedAt: "2026-10-03T11:00:00.000Z", mapFingerprint: fingerprint(approvedAgain), personaCheck: check });
    expect(deriveGuide(approvedAgain, selection, check).currentStepId).toBeNull();
  });

  it("stale and never-made are told apart on every record", () => {
    const state = all.find((s) => s.name === "fixture / selected slice-outcome-thread")!;
    const changed = updateCard(state.product, "step-export-work", { description: "Changed." });
    const stale = deriveGuide(changed, state.selection, state.check);
    const never = deriveGuide(changed, null, null);
    expect(stale.steps.find((s) => s.id === "select")!.stale).toBeDefined();
    expect(never.steps.find((s) => s.id === "select")!.stale).toBeUndefined();
    expect(stale.steps.find((s) => s.id === "people_check")!.stale).toBeDefined();
    expect(never.steps.find((s) => s.id === "people_check")!.stale).toBeUndefined();
    expect(resolveSelection(changed, state.selection!)).toMatchObject({ ok: false, issues: [{ code: "stale_selection" }] });
    expect(resolvePersonaCheck(changed, null)).toMatchObject({ ok: false, issues: [{ code: "persona_check_required" }] });
    expect(resolvePersonaCheck(changed, state.check)).toMatchObject({ ok: false, issues: [{ code: "stale_persona_check" }] });
  });
});

describe("re-entry: the fingerprint itself tells meaning apart, without any revision change", () => {
  // Two documents with the same revision and the same approval record, differing in one field of meaning only.
  const approved = () => approveRevision(loadFixture(), APPROVAL);
  const variants: [string, (p: ProductDocument) => ProductDocument][] = [
    ["goal statement", (p) => ({ ...p, goal: { ...p.goal, statement: "Another goal." } })],
    ["need statement", (p) => ({ ...p, needs: p.needs.map((n) => (n.id === "need-buildable-slice" ? { ...n, statement: "Changed." } : n)) })],
    ["step description", (p) => ({ ...p, narrative: p.narrative.map((s) => (s.id === "step-export-work" ? { ...s, description: "Changed." } : s)) })],
    [
      "step order",
      (p) => ({
        ...p,
        narrative: p.narrative.map((s) => (s.sequence === 10 ? { ...s, sequence: 11 } : s.sequence === 11 ? { ...s, sequence: 10 } : s)),
      }),
    ],
    ["worst-case outcome", (p) => ({ ...p, wcbc: p.wcbc.map((b) => (b.id === "wcbc-no-small-slice" ? { ...b, outcome: { kind: "termination" as const } } : b)) })],
    ["a person's roles", (p) => ({ ...p, personas: p.personas.map((e) => (e.id === "persona-developer" ? { ...e, roles: ["user" as const] } : e)) })],
    ["a decision's status", (p) => ({ ...p, decisions: p.decisions.map((d) => (d.id === "dec-measure-faster" ? { ...d, status: "decided" as const, rationale: "Decided." } : d)) })],
    ["the product name", (p) => ({ ...p, product: { ...p.product, name: "Renamed" } })],
  ];

  it("each field of meaning changes the fingerprint; the revision and approval do not change", () => {
    const base = approved();
    for (const [name, change] of variants) {
      const other = change(base);
      expect(other.revision, name).toEqual(base.revision);
      expect(fingerprint(other), name).not.toBe(fingerprint(base));
    }
  });

  it("so a confirmation and a selection made on the base are stale on each variant, with the approval still standing", () => {
    const base = approved();
    const check = peopleCheck(base);
    const selection = selectSlice(base, { candidateId: "slice-outcome-thread", selectedBy: "Maya", selectedAt: "2026-10-02T09:00:00.000Z", mapFingerprint: fingerprint(base), personaCheck: check });
    for (const [name, change] of variants) {
      const other = change(base);
      expect(resolvePersonaCheck(other, check).ok, name).toBe(false);
      expect(resolveSelection(other, selection).ok, name).toBe(false);
      expect(buildExecutionBrief(other, selection).ok, name).toBe(false);
      const guide = deriveGuide(other, selection, check);
      expect(guide.currentStepId, name).toBe("people_check");
      expect(guide.steps.find((s) => s.id === "people_check")!.stale, name).toBeDefined();
    }
  });

  it("layout and key order change nothing", () => {
    const base = approved();
    const moved = { ...base, layout: { cards: { ...base.layout.cards, "step-main-path": { row: 2 } } } };
    expect(fingerprint(moved)).toBe(fingerprint(base));
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as ProductDocument;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(base));
    expect(fingerprint(reordered)).toBe(fingerprint(base));
  });
});
