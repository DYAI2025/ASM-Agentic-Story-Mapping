import { describe, expect, it } from "vitest";
import { BRIEF_VERSION, buildExecutionBrief, exportBriefJson, exportBriefMarkdown } from "../../src/domain/brief";
import { fingerprint } from "../../src/domain/fingerprint";
import { approveRevision, setActorRoles } from "../../src/domain/operations";
import type { ProductDocument } from "../../src/domain/schema";
import { SLICE_DERIVATION_VERSION, candidateFingerprint, proposeSlices } from "../../src/domain/slices";
import { resolveSelection, selectSlice } from "../../src/domain/work-state";
import { loadFixture, mutableFixture, peopleCheck } from "./helpers";

const APPROVAL = { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" };
const approved = (p: ProductDocument = loadFixture()) => approveRevision(p, APPROVAL);
const choose = (p: ProductDocument, candidateId = "slice-outcome-thread") =>
  selectSlice(p, { candidateId, selectedBy: "Maya", selectedAt: "2026-10-02T09:00:00.000Z", mapFingerprint: fingerprint(p), personaCheck: peopleCheck(p) });
const codes = (result: { ok: boolean; issues?: { code: string }[] }) => (result.issues ?? []).map((i) => i.code);

/** One persona on every step and no needs: the three readings collapse into one. */
function oneReading(): ProductDocument {
  const flat = mutableFixture();
  for (const step of flat.narrative) {
    step.personaIds = ["persona-developer"];
    step.needIds = [];
  }
  return flat;
}

describe("fewer than two candidates, with the reason", () => {
  it("a map with one distinct reading offers that one candidate and says why there is no second", () => {
    const proposal = proposeSlices(oneReading());
    if (!proposal.ok) throw new Error(JSON.stringify(proposal.issues));
    expect(proposal.candidates).toHaveLength(1);
    expect(proposal.candidates[0].id).toBe("slice-primary-persona");
    expect(proposal.fewerBecause).toBeDefined();
    expect(proposal.fewerBecause).toContain("the reading “Thread to “Export execution-ready work”” has no steps");
    expect(proposal.fewerBecause).toContain("the reading “Steps shared between personas” has no steps");
    expect(proposal.fewerBecause).toContain("no need");
    // Readable: no doubled full stops, no quote nested in a quote of the same title.
    expect(proposal.fewerBecause).not.toMatch(/\.\./);
    expect(proposal.fewerBecause).not.toContain("“““");
  });

  it("two or three candidates come without such a note, and are what they were", () => {
    const proposal = proposeSlices(loadFixture());
    if (!proposal.ok) throw new Error("no candidates");
    expect(proposal.fewerBecause).toBeUndefined();
    expect(proposal.candidates.map((c) => [c.id, candidateFingerprint(c)])).toEqual([
      ["slice-primary-persona", "fbfe93f0"],
      ["slice-outcome-thread", "8f0e9a22"],
      ["slice-shared-steps", "f2a66927"],
    ]);
  });

  it("a map with no reading at all is still refused, with the reason", () => {
    const single = mutableFixture();
    single.narrative = [single.narrative[0]];
    single.wcbc = [];
    single.decisions = [];
    expect(codes(proposeSlices(single))).toEqual(["narrative_too_short"]);

    const nobody = mutableFixture();
    nobody.narrative.forEach((s) => ((s.personaIds = []), (s.needIds = [])));
    expect(codes(proposeSlices(nobody))).toEqual(["too_few_candidates"]);
  });

  it("the one candidate can be selected by a human like any other; no other id is a candidate", () => {
    const p = approved(oneReading());
    const selection = choose(p, "slice-primary-persona");
    expect(resolveSelection(p, selection).ok).toBe(true);
    expect(() => choose(p, "slice-outcome-thread")).toThrow(/not a slice candidate/);
  });

  it("the rules changed, so their version did: a selection made under version 1 is stale", () => {
    expect(SLICE_DERIVATION_VERSION).toBe(2);
    const p = approved();
    expect(codes(resolveSelection(p, { ...choose(p), derivationVersion: 1 }))).toEqual(["stale_selection"]);
  });
});

describe("work order contract version 3", () => {
  const exported = () => {
    const p = approved(setActorRoles(loadFixture(), "persona-developer", ["user", "delivery_participant"]));
    const selection = choose(p);
    const result = buildExecutionBrief(p, selection);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return { p, selection, brief: result.brief };
  };

  it("is version 3, machine-readable in JSON and in Markdown", () => {
    const { brief } = exported();
    expect(BRIEF_VERSION).toBe(3);
    expect(JSON.parse(exportBriefJson(brief)).briefVersion).toBe(3);
    expect(exportBriefMarkdown(brief)).toContain("Work order contract: `asm.execution-brief`, briefVersion 3.");
  });

  it("carries the people check the slice was selected under, next to approval and selection", () => {
    const { brief } = exported();
    expect(brief.approvedContext.peopleConsidered).toEqual({
      confirmedBy: "Maya",
      confirmedAt: "2026-10-02T08:30:00.000Z",
      note: "A named human confirmed that they considered who else is relevant for the goal. That is what they did; it does not say the people on the map are complete.",
    });
    const markdown = exportBriefMarkdown(brief);
    expect(markdown).toContain("- Who else matters: considered by Maya at 2026-10-02T08:30:00.000Z.");
    expect(markdown).toContain("does not say the people on the map are complete");
  });

  it("every person carries their roles and persona answer, as the map states them", () => {
    const { brief } = exported();
    const developer = brief.personas.find((e) => e.id === "persona-developer")!;
    expect(developer).toEqual({
      id: "persona-developer",
      name: "Developer",
      description: developer.description,
      roles: ["user", "delivery_participant"],
      persona: true,
    });
    const lead = brief.personas.find((e) => e.id === "persona-product-lead")!;
    expect(lead.roles).toEqual([]);
    expect(lead.persona).toBe(true);
    expect(exportBriefMarkdown(brief)).toContain("- **Developer** (`persona-developer`, User, Delivery participant, persona) —");
    expect(exportBriefMarkdown(brief)).toContain("- **Product Lead / Product Owner** (`persona-product-lead`, role not stated, persona) —");
  });

  it("still binds revision, map fingerprint, candidate fingerprint and derivation version", () => {
    const { p, selection, brief } = exported();
    expect(brief.sourceMapRevision).toMatchObject({ revision: 1, mapFingerprint: fingerprint(p) });
    expect(brief.approvedContext.selection).toMatchObject({
      candidateFingerprint: selection.candidateFingerprint,
      derivationVersion: SLICE_DERIVATION_VERSION,
    });
  });

  it("is derived from the approved document and the selection, and from nothing else: the same inputs give the same bytes", () => {
    const a = exported();
    const b = exported();
    expect(exportBriefJson(a.brief)).toBe(exportBriefJson(b.brief));
  });
});
