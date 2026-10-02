import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BRIEF_VERSION, buildExecutionBrief, exportBriefJson, exportBriefMarkdown } from "../../src/domain/brief";
import { fingerprint } from "../../src/domain/fingerprint";
import { allIds } from "../../src/domain/map-patch";
import { approveRevision, moveStep, setCardRow, updateCard } from "../../src/domain/operations";
import type { ProductDocument } from "../../src/domain/schema";
import { exportProductYaml } from "../../src/domain/serialize";
import { SLICE_DERIVATION_VERSION, candidateFingerprint, checkSliceCandidate, proposeSlices, type SliceCandidate } from "../../src/domain/slices";
import { validateProduct } from "../../src/domain/validate";
import { resolveSelection, selectSlice, type SliceSelection } from "../../src/domain/work-state";
import { loadFixture, mutableFixture, peopleCheck } from "./helpers";

const APPROVAL = { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" };
const approved = (p: ProductDocument = loadFixture()) => approveRevision(p, APPROVAL);
const codes = (result: object) => ("issues" in result ? (result.issues as { code: string }[]) : []).map((i) => i.code);

function candidates(p: ProductDocument): SliceCandidate[] {
  const proposal = proposeSlices(p);
  if (!proposal.ok) throw new Error(JSON.stringify(proposal.issues));
  return proposal.candidates;
}

const choose = (p: ProductDocument, candidateId = "slice-outcome-thread", selectedBy = "Maya") =>
  selectSlice(p, { candidateId, selectedBy, selectedAt: "2026-10-02T09:00:00.000Z", mapFingerprint: fingerprint(p), personaCheck: peopleCheck(p) });

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
    expect(codes(buildExecutionBrief(product, undefined))).toEqual(["selection_required"]);
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
      selectSlice(product, { candidateId: "slice-outcome-thread", selectedBy: "Maya", selectedAt: "2026-10-02T09:00:00.000Z", mapFingerprint: "00000000", personaCheck: peopleCheck(product) }),
    ).toThrow(/has changed/);
  });

  it("only a candidate of this map can be selected", () => {
    expect(() => choose(approved(), "slice-made-up")).toThrow(/not a slice candidate/);
  });

  it("records who selected what, on which revision, map, candidate and derivation rules", () => {
    const product = approved();
    const candidate = candidates(product).find((c) => c.id === "slice-outcome-thread")!;
    expect(choose(product)).toEqual({
      candidateId: "slice-outcome-thread",
      productId: "asm",
      revision: 1,
      mapFingerprint: fingerprint(product),
      candidateFingerprint: candidateFingerprint(candidate),
      derivationVersion: SLICE_DERIVATION_VERSION,
      selectedBy: "Maya",
      selectedAt: "2026-10-02T09:00:00.000Z",
      personaCheck: { confirmedBy: "Maya", confirmedAt: "2026-10-02T08:30:00.000Z" },
    });
  });

  it("a layout change keeps the selection current", () => {
    const product = approved();
    const selection = choose(product);
    const nudged = setCardRow(product, "step-main-path", 1);
    expect(fingerprint(nudged)).toBe(fingerprint(product));
    expect(resolveSelection(nudged, selection)).toMatchObject({ ok: true, candidate: { id: "slice-outcome-thread" } });
  });

  it("a change of meaning makes the selection stale along with ending the approval", () => {
    const product = approved();
    const selection = choose(product);
    for (const changed of [updateCard(product, "step-main-path", { title: "Lay out the path" }), moveStep(product, "step-main-path", 1)]) {
      expect(changed.revision).toEqual({ number: 2, status: "proposed" });
      expect(codes(resolveSelection(changed, selection))).toEqual(["stale_selection"]);
    }
  });

  it("a product document that carries a selection is not a valid product document", () => {
    const forged = { ...approved(), selectedSlice: choose(approved()) };
    expect(codes(validateProduct(forged))).toEqual(["schema_unrecognized_keys"]);
  });
});

describe("execution brief", () => {
  function selected(p: ProductDocument = approved()): [ProductDocument, SliceSelection] {
    return [p, choose(p)];
  }
  function brief(p: ProductDocument, selection: SliceSelection) {
    const result = buildExecutionBrief(p, selection);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.brief;
  }

  it("is refused without a human selection or without approval", () => {
    expect(codes(buildExecutionBrief(loadFixture(), undefined))).toEqual(["selection_required"]);
    expect(codes(buildExecutionBrief(approved(), null))).toEqual(["selection_required"]);
    expect(codes(buildExecutionBrief(loadFixture(), choose(approved())))).toEqual(["approval_required"]);
  });

  it("references the exact map revision it was made from", () => {
    const [first, firstSelection] = selected();
    expect(brief(first, firstSelection).sourceMapRevision).toEqual({
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
    const [second, secondSelection] = selected(approveRevision(edited, { approvedBy: "Ada", approvedAt: "2026-10-03T10:00:00.000Z" }));
    expect(brief(second, secondSelection).sourceMapRevision).toMatchObject({ revision: 2, approvedAt: "2026-10-03T10:00:00.000Z", mapFingerprint: fingerprint(second) });
    expect(fingerprint(second)).not.toBe(fingerprint(first));
    expect(exportBriefMarkdown(brief(second, secondSelection))).toContain(`revision 2 (\`${fingerprint(second)}\`)`);
  });

  it("is deterministic and mentions only ids that are on the map", () => {
    const [product, selection] = selected();
    expect(exportBriefJson(brief(product, selection))).toBe(exportBriefJson(brief(product, selection)));
    const ids = allIds(product);
    const b = brief(product, selection);
    const mentioned = [
      b.goal.id,
      ...b.inScope.flatMap((s) => [s.id, ...s.personaIds, ...s.needIds, ...s.branches.map((x) => x.id)]),
      ...b.personas.map((e) => e.id),
      ...b.needs.flatMap((e) => [e.id, e.personaId]),
      ...b.acceptanceCriteriaDraft.flatMap((c) => c.refs),
      ...b.approvedContext.decidedDecisions.flatMap((d) => [d.id, ...d.relatesTo]),
      ...b.approvedContext.value.needIds,
      ...b.openHumanDecisions.flatMap((d) => d.relatesTo),
    ];
    for (const id of mentioned) expect(ids.has(id), id).toBe(true);
  });

  it("contains every required section, in JSON and in Markdown", () => {
    const b = brief(...selected());
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
    expect(b.goal.slice).toEqual({ id: "slice-outcome-thread", title: "Thread to “Export execution-ready work”" });
    expect(b.inScope.map((s) => s.id)).toEqual(["step-main-path", "step-review-slices", "step-select-slice", "step-export-work"]);
    expect(b.personas.map((e) => e.id)).toEqual(["persona-product-lead", "persona-domain-ux", "persona-developer"]);
    expect(b.needs.map((e) => e.id)).toEqual(["need-shared-narrative", "need-approve-meaning", "need-buildable-slice", "need-stable-references"]);
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

  // The contract changed with approvedContext.value and the selection's candidateFingerprint and derivationVersion.
  it("identifies work order contract version 2, in JSON and in Markdown", () => {
    const b = brief(...selected());
    expect(BRIEF_VERSION).toBe(2);
    expect(b.briefVersion).toBe(2);
    expect(exportBriefJson(b)).toContain('"briefVersion": 2');
    expect(JSON.parse(exportBriefJson(b)).briefVersion).toBe(2);
    expect(exportBriefMarkdown(b)).toContain("Work order contract: `asm.execution-brief`, briefVersion 2.");
  });

  it("no checked-in example or fixture claims another contract version", () => {
    const root = path.join(__dirname, "..", "..");
    const examples = path.join(root, "docs", "examples");
    const names = readdirSync(examples);
    const json = names.filter((n) => n.endsWith(".json"));
    const markdown = names.filter((n) => n.endsWith(".md"));
    expect(json.length).toBeGreaterThan(0);
    expect(markdown.length).toBe(json.length);
    for (const name of json) expect(JSON.parse(readFileSync(path.join(examples, name), "utf8")).briefVersion, name).toBe(2);
    for (const name of markdown) {
      const claimed = [...readFileSync(path.join(examples, name), "utf8").matchAll(/briefVersion (\d+)/g)].map((m) => m[1]);
      expect(claimed, name).toEqual(["2"]);
    }

    const files = [
      path.join(root, "README.md"),
      ...[examples, path.join(root, "tests", "fixtures"), path.join(root, "product")].flatMap((dir) =>
        readdirSync(dir, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(entry.parentPath, entry.name)),
      ),
    ];
    const stale = files.filter((file) => /briefVersion\W{0,3}(?!2\b)\d+/.test(readFileSync(file, "utf8")));
    expect(stale).toEqual([]);
  });
});
