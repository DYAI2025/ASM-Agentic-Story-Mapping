import { describe, expect, it } from "vitest";
import { buildExecutionBrief, exportBriefJson, exportBriefMarkdown } from "../../src/domain/brief";
import { fingerprint } from "../../src/domain/fingerprint";
import { allIds } from "../../src/domain/map-patch";
import { approveRevision, moveStep, setCardRow, updateCard } from "../../src/domain/operations";
import type { ProductDocument } from "../../src/domain/schema";
import { exportProductYaml, parseProductText } from "../../src/domain/serialize";
import { checkSliceCandidate, proposeSlices, selectSlice, type SliceCandidate } from "../../src/domain/slices";
import { validateProduct } from "../../src/domain/validate";
import { loadFixture, mutableFixture } from "./helpers";

const APPROVAL = { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" };
const approved = (p: ProductDocument = loadFixture()) => approveRevision(p, APPROVAL);
const codes = (result: object) => ("issues" in result ? (result.issues as { code: string }[]) : []).map((i) => i.code);

function candidates(p: ProductDocument): SliceCandidate[] {
  const proposal = proposeSlices(p);
  if (!proposal.ok) throw new Error(JSON.stringify(proposal.issues));
  return proposal.candidates;
}

const choose = (p: ProductDocument, candidateId = "slice-outcome-thread", selectedBy = "Maya") =>
  selectSlice(p, { candidateId, selectedBy, selectedAt: "2026-10-02T09:00:00.000Z", mapFingerprint: fingerprint(p) });

/** Every id a candidate mentions: in its id lists and as `[id]` in its text. */
function mentionedIds(c: SliceCandidate): string[] {
  const text = [...c.whyNow, ...c.assumptions, ...c.unresolvedQuestions, ...c.acceptanceCriteria, ...c.outOfScope].join("\n");
  return [c.goalId, ...c.stepIds, ...c.personaIds, ...c.needIds, ...[...text.matchAll(/\[([a-z][a-z0-9-]*)\]/g)].map((m) => m[1])];
}

describe("slice candidates", () => {
  it("proposes three candidates for the ASM map, each a different reading of it", () => {
    const found = candidates(loadFixture());
    expect(found.map((c) => c.id)).toEqual(["slice-primary-persona", "slice-outcome-thread", "slice-shared-steps"]);
    expect(found[0].stepIds).toHaveLength(9);
    expect(found[1].stepIds).toEqual(["step-main-path", "step-review-slices", "step-select-slice", "step-export-work"]);
    expect(found[2].stepIds).toEqual([
      "step-describe-idea",
      "step-define-personas",
      "step-main-path",
      "step-add-wcbc",
      "step-review-gaps",
      "step-review-slices",
    ]);
  });

  it("is deterministic and always yields two or three candidates or a reason", () => {
    expect(proposeSlices(loadFixture())).toEqual(proposeSlices(loadFixture()));

    const single = mutableFixture();
    single.narrative = [single.narrative[0]];
    single.wcbc = [];
    single.decisions = [];
    expect(codes(proposeSlices(single))).toEqual(["narrative_too_short"]);

    // One persona on every step and no needs: only one distinct reading is left.
    const flat = mutableFixture();
    for (const step of flat.narrative) {
      step.personaIds = ["persona-developer"];
      step.needIds = [];
    }
    expect(codes(proposeSlices(flat))).toEqual(["too_few_candidates"]);
  });

  it("every candidate carries the required fields and explains itself from the map", () => {
    for (const c of candidates(loadFixture())) {
      for (const key of ["id", "title", "stepIds", "personaIds", "needIds", "whyNow", "assumptions", "unresolvedQuestions", "acceptanceCriteria", "outOfScope"] as const)
        expect(c[key].length).toBeGreaterThan(0);
      expect(c.whyNow.join("\n")).toMatch(/Primary persona relevance: .+ takes part in \d+ of the \d+ included steps/);
      expect(c.whyNow.join("\n")).toMatch(/Persona overlap: \d+ of the \d+/);
      expect(c.whyNow.join("\n")).toMatch(/Need relation: serves \d+ of 6 needs/);
      expect(c.whyNow.join("\n")).toMatch(/Scope: \d+ of 11 main-path steps/);
      expect(c.evidence.stepCount).toBe(c.stepIds.length);
    }
  });

  it("carries no score, rank or business value", () => {
    const text = JSON.stringify(candidates(loadFixture()));
    expect(text).not.toMatch(/"(score|rank|ranking|priority|businessValue|value|recommended)"/i);
  });

  it("references only ids that exist on the map", () => {
    const maps = [loadFixture(), moveStep(loadFixture(), "step-main-path", 1)];
    const reduced = mutableFixture();
    reduced.narrative[10].needIds = ["need-see-gaps"];
    maps.push(reduced);

    for (const map of maps) {
      const ids = allIds(map);
      for (const c of candidates(map)) {
        for (const id of mentionedIds(c)) expect(ids.has(id), `${c.id} mentions ${id}`).toBe(true);
        expect(checkSliceCandidate(map, c)).toEqual({ issues: [], flags: [] });
      }
    }
  });

  it("rejects a candidate that names an id the map does not have", () => {
    const [c] = candidates(loadFixture());
    expect(codes(checkSliceCandidate(loadFixture(), { ...c, stepIds: [...c.stepIds, "step-ghost"] }))).toEqual(["unknown_id"]);
    expect(codes(checkSliceCandidate(loadFixture(), { ...c, needIds: ["need-ghost"] }))).toEqual(["unknown_id"]);
    expect(codes(checkSliceCandidate(loadFixture(), { ...c, personaIds: ["persona-ghost"] }))).toEqual(["unknown_id"]);
    expect(codes(checkSliceCandidate(loadFixture(), { ...c, stepIds: [] }))).toEqual(["empty_slice"]);
  });

  it("rejects a candidate without the goal and flags one without a need", () => {
    const [c] = candidates(loadFixture());
    expect(codes(checkSliceCandidate(loadFixture(), { ...c, goalId: "" }))).toEqual(["missing_goal_reference"]);
    expect(codes(checkSliceCandidate(loadFixture(), { ...c, goalId: "goal-something-else" }))).toEqual(["missing_goal_reference"]);
    expect(checkSliceCandidate(loadFixture(), { ...c, needIds: [] })).toMatchObject({
      issues: [],
      flags: [{ code: "missing_need_reference" }],
    });

    // A generated candidate whose steps name no need arrives flagged.
    const needless = mutableFixture();
    for (const step of needless.narrative) if (step.personaIds.length > 1) step.needIds = [];
    const shared = candidates(needless).find((x) => x.id === "slice-shared-steps")!;
    expect(shared.needIds).toEqual([]);
    expect(shared.flags.map((f) => f.code)).toEqual(["missing_need_reference"]);
    expect(shared.assumptions.join(" ")).toContain("none of them names a need");
  });
});

describe("the human gate", () => {
  it("proposing never selects: no candidate becomes canonical by itself", () => {
    const product = approved();
    const before = exportProductYaml(product);
    candidates(product);
    expect(exportProductYaml(product)).toBe(before);
    expect(product.selectedSlice).toBeUndefined();
    expect(codes(buildExecutionBrief(product))).toEqual(["selection_required"]);
  });

  it("selection needs a named human", () => {
    expect(() => choose(approved(), "slice-outcome-thread", "  ")).toThrow(/name of the human/);
  });

  it("selection needs an approved revision", () => {
    expect(() => choose(loadFixture())).toThrow(/not approved/);
  });

  it("selection is refused for a map other than the one the human looked at", () => {
    const product = approved();
    expect(() =>
      selectSlice(product, { candidateId: "slice-outcome-thread", selectedBy: "Maya", selectedAt: "2026-10-02T09:00:00.000Z", mapFingerprint: "00000000" }),
    ).toThrow(/has changed/);
  });

  it("only a candidate of this map can be selected", () => {
    expect(() => choose(approved(), "slice-made-up")).toThrow(/not a slice candidate/);
  });

  it("records who selected what, on which revision", () => {
    const product = choose(approved());
    expect(product.selectedSlice).toEqual({
      candidateId: "slice-outcome-thread",
      title: "Thread to “Export execution-ready work”",
      stepIds: ["step-main-path", "step-review-slices", "step-select-slice", "step-export-work"],
      personaIds: ["persona-product-lead", "persona-domain-ux", "persona-developer"],
      needIds: ["need-shared-narrative", "need-approve-meaning", "need-buildable-slice", "need-stable-references"],
      selectedBy: "Maya",
      selectedAt: "2026-10-02T09:00:00.000Z",
      revision: 1,
      mapFingerprint: fingerprint(product),
    });
    expect(product.revision.status).toBe("approved");
    const back = parseProductText(exportProductYaml(product));
    expect(back.ok && back.product).toEqual(product);
  });

  it("selecting does not change the meaning of the map; a layout change keeps the selection", () => {
    const before = approved();
    const selected = choose(before);
    expect(fingerprint(selected)).toBe(fingerprint(before));
    expect(setCardRow(selected, "step-main-path", 1).selectedSlice).toEqual(selected.selectedSlice);
  });

  it("a change of meaning ends the selection along with the approval", () => {
    const selected = choose(approved());
    for (const changed of [updateCard(selected, "step-main-path", { title: "Lay out the path" }), moveStep(selected, "step-main-path", 1)]) {
      expect(changed.selectedSlice).toBeUndefined();
      expect(changed.revision).toEqual({ number: 2, status: "proposed" });
    }
  });

  it("a forged or stale selection in a file is rejected", () => {
    const selected = choose(approved());

    const edited = structuredClone(selected);
    edited.narrative[0].title = "Edited by hand";
    expect(codes(validateProduct(edited))).toEqual(["stale_selection"]);

    const unapproved = structuredClone(selected);
    unapproved.revision = { number: 1, status: "proposed" };
    expect(codes(validateProduct(unapproved))).toContain("selection_requires_approval");

    const ghost = structuredClone(selected);
    ghost.selectedSlice!.stepIds = ["step-ghost"];
    expect(codes(validateProduct(ghost))).toEqual(["unknown_step"]);
  });
});

describe("execution brief", () => {
  const selected = () => choose(approved());
  function brief(p: ProductDocument) {
    const result = buildExecutionBrief(p);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.brief;
  }

  it("is refused without a human selection or without approval", () => {
    expect(codes(buildExecutionBrief(loadFixture()))).toEqual(["selection_required"]);
    expect(codes(buildExecutionBrief(approved()))).toEqual(["selection_required"]);
  });

  it("references the exact map revision it was made from", () => {
    const first = selected();
    expect(brief(first).sourceMapRevision).toEqual({
      productId: "asm",
      productName: "ASM – Agentic Story Mapping",
      schemaVersion: 1,
      revision: 1,
      status: "approved",
      approvedBy: "Ada",
      approvedAt: "2026-10-01T10:00:00.000Z",
      mapFingerprint: fingerprint(first),
    });

    // Another revision of the map yields another revision and fingerprint in the brief.
    const edited = updateCard(first, "step-export-work", { description: "The slice leaves ASM as a work order." });
    const second = choose(approveRevision(edited, { approvedBy: "Ada", approvedAt: "2026-10-03T10:00:00.000Z" }));
    expect(brief(second).sourceMapRevision).toMatchObject({ revision: 2, approvedAt: "2026-10-03T10:00:00.000Z", mapFingerprint: fingerprint(second) });
    expect(fingerprint(second)).not.toBe(fingerprint(first));
    expect(exportBriefMarkdown(brief(second))).toContain(`revision 2 (\`${fingerprint(second)}\`)`);
  });

  it("is deterministic and mentions only ids that are on the map", () => {
    const product = selected();
    expect(exportBriefJson(brief(product))).toBe(exportBriefJson(brief(product)));
    const ids = allIds(product);
    const b = brief(product);
    const mentioned = [
      b.goal.id,
      ...b.inScope.flatMap((s) => [s.id, ...s.personaIds, ...s.needIds, ...s.branches.map((x) => x.id)]),
      ...b.personas.map((e) => e.id),
      ...b.needs.flatMap((e) => [e.id, e.personaId]),
      ...b.acceptanceCriteriaDraft.flatMap((c) => c.refs),
      ...b.approvedContext.decidedDecisions.flatMap((d) => [d.id, ...d.relatesTo]),
      ...b.openHumanDecisions.flatMap((d) => d.relatesTo),
    ];
    for (const id of mentioned) expect(ids.has(id), id).toBe(true);
  });

  it("contains every required section, in JSON and in Markdown", () => {
    const b = brief(selected());
    expect(Object.keys(b)).toEqual([
      "briefVersion",
      "kind",
      "goal",
      "approvedContext",
      "inScope",
      "outOfScope",
      "personas",
      "needs",
      "acceptanceCriteriaDraft",
      "verificationExpectations",
      "openHumanDecisions",
      "sourceMapRevision",
    ]);
    expect(b.inScope.map((s) => s.id)).toEqual(["step-main-path", "step-review-slices", "step-select-slice", "step-export-work"]);
    expect(b.outOfScope).toHaveLength(9);
    expect(b.acceptanceCriteriaDraft.length).toBe(b.verificationExpectations.length);
    expect(b.openHumanDecisions.map((d) => d.id)).toEqual([
      "dec-measure-faster",
      "dec-slice-criteria",
      "dec-export-format",
      "wcbc_without_outcome:wcbc-no-small-slice",
      "wcbc_without_outcome:wcbc-export-invalid",
    ]);
    expect(b.approvedContext.verified).toEqual([]);
    expect(b.approvedContext.selection).toMatchObject({ selectedBy: "Maya", candidateId: "slice-outcome-thread" });

    const headings = [...exportBriefMarkdown(b).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "GOAL",
      "VERIFIED / APPROVED CONTEXT",
      "IN SCOPE",
      "OUT OF SCOPE",
      "PERSONAS / NEEDS",
      "ACCEPTANCE CRITERIA DRAFT",
      "VERIFICATION EXPECTATIONS",
      "OPEN HUMAN DECISIONS",
      "SOURCE MAP REVISION",
    ]);
  });
});
