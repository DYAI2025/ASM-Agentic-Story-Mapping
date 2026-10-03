import { describe, expect, it } from "vitest";
import { reviewWithRules } from "../../src/agent/fake-review";
import { fingerprint } from "../../src/domain/fingerprint";
import { applyMapPatch } from "../../src/domain/map-patch";
import { approveRevision, setWcbcOutcome, updateCard } from "../../src/domain/operations";
import { buildReviewPatch, resolveReview, reviewNarrative, type AgentReviewOutput, FINDING_LABEL } from "../../src/domain/review";
import { exportProductYaml, parseProductText } from "../../src/domain/serialize";
import { validateProduct } from "../../src/domain/validate";
import { loadFixture, mutableFixture } from "./helpers";

const codes = (result: object) => ("issues" in result ? (result.issues as { code: string }[]) : []).map((i) => i.code);
const findingCodes = (p: Parameters<typeof reviewNarrative>[0]) => reviewNarrative(p).map((f) => f.code);
const APPROVAL = { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" };

function resolved(product = loadFixture(), output: unknown = reviewWithRules(product)) {
  const result = resolveReview(product, output, "stub");
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.review;
}

/** One valid finding, to be broken one field at a time. */
function oneFinding(patch: Partial<AgentReviewOutput["findings"][number]> = {}): AgentReviewOutput {
  return {
    summary: "s",
    findings: [
      {
        kind: "missing_transition",
        message: "The handover to the developer is not described.",
        relatesTo: ["step-select-slice", "step-export-work"],
        evidence: { snippet: "Export execution-ready work", rationale: "r", confidence: 0.4 },
        proposal: null,
        ...patch,
      },
    ],
  };
}

describe("deterministic narrative review", () => {
  it("is deterministic and reports the ASM map's real gaps", () => {
    const product = loadFixture();
    expect(reviewNarrative(product)).toEqual(reviewNarrative(product));
    expect(findingCodes(product).filter((c) => c === "wcbc_without_outcome")).toHaveLength(6);
    expect(reviewNarrative(product).filter((f) => f.level === "gap")).toHaveLength(6);
    expect(reviewNarrative(product).find((f) => f.code === "need_persona_not_on_step")?.relatesTo).toEqual([
      "step-select-slice",
      "need-buildable-slice",
      "persona-developer",
    ]);
  });

  it("every finding points at ids that exist on the map", () => {
    const product = mutableFixture();
    product.narrative[0].personaIds = [];
    product.narrative[1].needIds = [];
    const ids = new Set(JSON.stringify(product).match(/"(?:id)":"[^"]+"/g)!.map((m) => m.slice(6, -1)));
    for (const finding of reviewNarrative(product)) for (const id of finding.relatesTo) expect(ids.has(id)).toBe(true);
  });

  it("flags a step without an actor", () => {
    const product = mutableFixture();
    product.narrative[2].personaIds = [];
    expect(reviewNarrative(product).find((f) => f.code === "step_without_persona")?.relatesTo).toEqual(["step-confirm-intent"]);
  });

  it("flags a behaviour with neither a need nor an explicit rationale, and accepts a decided decision as rationale", () => {
    const product = mutableFixture();
    product.narrative.find((s) => s.id === "step-start-product")!.needIds = [];
    expect(reviewNarrative(product).find((f) => f.code === "behavior_without_need")?.relatesTo).toEqual(["step-start-product"]);

    product.decisions.push({ id: "dec-why-start", title: "Why", status: "open", rationale: "", relatesTo: ["step-start-product"] });
    expect(findingCodes(product)).toContain("behavior_without_need");

    product.decisions[product.decisions.length - 1] = {
      id: "dec-why-start",
      title: "Why",
      status: "decided",
      rationale: "Every map has to begin somewhere.",
      relatesTo: ["step-start-product"],
    };
    expect(findingCodes(product)).not.toContain("behavior_without_need");
  });

  it("requires a main path with a known start and end", () => {
    const empty = { ...mutableFixture(), narrative: [], wcbc: [], decisions: [] };
    expect(findingCodes(empty)).toContain("main_path_missing");

    const single = mutableFixture();
    single.narrative = [single.narrative[0]];
    single.wcbc = [];
    single.decisions = [];
    expect(findingCodes(single)).toContain("main_path_single_step");
    expect(findingCodes(loadFixture())).not.toContain("main_path_single_step");
  });

  it("finds orphaned needs and personas", () => {
    const product = mutableFixture();
    product.personas.push({ id: "persona-auditor", name: "Auditor", description: "" });
    product.needs.push({ id: "need-audit-trail", personaId: "persona-auditor", statement: "See who approved what." });
    const found = reviewNarrative(product);
    expect(found.find((f) => f.code === "orphan_need")?.relatesTo).toEqual(["need-audit-trail"]);
    expect(found.find((f) => f.code === "orphan_persona")?.relatesTo).toEqual(["persona-auditor"]);
  });

  it("a worst case must reference a recovery, termination or escalation state, and the reference must be valid", () => {
    const id = "wcbc-vague-discussion";
    const finding = (p: Parameters<typeof reviewNarrative>[0]) => reviewNarrative(p).some((f) => f.relatesTo[0] === id);
    expect(finding(loadFixture())).toBe(true);

    for (const outcome of [
      { kind: "recovery", resumeStepId: "step-describe-idea" },
      { kind: "escalation", toPersonaId: "persona-product-lead" },
      { kind: "termination" },
    ] as const)
      expect(finding(setWcbcOutcome(loadFixture(), id, outcome))).toBe(false);

    expect(() => setWcbcOutcome(loadFixture(), id, { kind: "recovery", resumeStepId: "step-ghost" })).toThrow(/does not exist/);
    const forged = mutableFixture();
    forged.wcbc[1].outcome = { kind: "escalation", toPersonaId: "persona-ghost" };
    expect(codes(validateProduct(forged))).toEqual(["unknown_persona"]);
  });

  it("an outcome survives export and import and does not disturb files without one", () => {
    const withOutcome = setWcbcOutcome(loadFixture(), "wcbc-vague-discussion", { kind: "recovery", resumeStepId: "step-describe-idea" });
    const back = parseProductText(exportProductYaml(withOutcome));
    expect(back.ok && back.product.wcbc[1].outcome).toEqual({ kind: "recovery", resumeStepId: "step-describe-idea" });
    expect(exportProductYaml(loadFixture())).not.toContain("outcome");
  });

  it("duplicate ids are rejected before any review", () => {
    const product = mutableFixture();
    product.wcbc[1].id = product.wcbc[0].id;
    expect(codes(validateProduct(product))).toEqual(["duplicate_id"]);
  });
});

describe("agent findings", () => {
  it("each finding references existing ids or is an explicit NEW_PROPOSAL", () => {
    const product = loadFixture();
    const review = resolved(product);
    const ids = new Set([product.goal.id, ...product.personas, ...product.needs, ...product.narrative, ...product.wcbc, ...product.decisions].map((e) => (typeof e === "string" ? e : e.id)));

    expect(review.findings.map((f) => f.kind)).toEqual([
      ...Array(5).fill("missing_wcbc"),
      "missing_transition",
      "missing_product_question",
      "missing_product_question",
    ]);
    for (const finding of review.findings) {
      for (const id of finding.relatesTo) expect(ids.has(id)).toBe(true);
      expect(finding.relatesTo.length > 0 || finding.origin === "NEW_PROPOSAL").toBe(true);
    }
    expect(review.findings.filter((f) => f.origin === "NEW_PROPOSAL")).toHaveLength(7);
    expect(review.findings[5]).toMatchObject({ origin: "existing", relatesTo: ["step-select-slice", "step-export-work"] });
  });

  it("rejects a finding that is anchored to nothing", () => {
    expect(codes(resolveReview(loadFixture(), oneFinding({ relatesTo: [] }), "stub"))).toEqual(["unanchored_finding"]);
  });

  it("rejects invented and stale ids", () => {
    // Refused where the finding is read, not only later when a patch would be applied.
    expect(resolveReview(loadFixture(), oneFinding({ relatesTo: ["step-ghost"] }), "stub")).toEqual({
      ok: false,
      issues: [{ code: "unknown_id", path: "findings[0].relatesTo[0]", message: 'id "step-ghost" does not exist on the map' }],
    });

    // An id that was valid on an earlier map is stale on a map that no longer has it.
    const later = mutableFixture();
    later.narrative = later.narrative.filter((s) => s.id !== "step-export-work");
    later.wcbc = later.wcbc.filter((b) => b.stepId !== "step-export-work");
    later.decisions = later.decisions.filter((d) => !d.relatesTo.includes("step-export-work"));
    expect(validateProduct(later).ok).toBe(true);
    expect(codes(resolveReview(later, oneFinding({ evidence: { snippet: "Human selects first slice", rationale: "", confidence: 0.4 } }), "stub"))).toEqual(["unknown_id"]);
  });

  it("rejects ids inside a NEW_PROPOSAL that are not on the map", () => {
    const wcbc = (outcome: object, step = "step-start-product") =>
      oneFinding({
        kind: "missing_wcbc",
        proposal: { type: "NEW_PROPOSAL", item: "wcbc", step, kind: "worst_case", title: "It fails", description: "", recovery: "", outcome } as never,
      });
    expect(codes(resolveReview(loadFixture(), wcbc({ kind: "termination", step: null, persona: null }, "step-ghost"), "stub"))).toEqual(["unknown_id"]);
    expect(codes(resolveReview(loadFixture(), wcbc({ kind: "recovery", step: "step-ghost", persona: null }), "stub"))).toEqual(["unknown_id"]);
    expect(codes(resolveReview(loadFixture(), wcbc({ kind: "recovery", step: null, persona: null }), "stub"))).toEqual(["invalid_outcome"]);
    expect(codes(resolveReview(loadFixture(), wcbc({ kind: "escalation", step: null, persona: "persona-ghost" }), "stub"))).toEqual(["unknown_id"]);
    expect(resolveReview(loadFixture(), wcbc({ kind: "escalation", step: null, persona: "persona-developer" }), "stub").ok).toBe(true);
  });

  it("rejects evidence that is not on the map and output outside the contract", () => {
    const product = loadFixture();
    expect(codes(resolveReview(product, oneFinding({ evidence: { snippet: "The CEO said so", rationale: "", confidence: 1 } }), "stub"))).toEqual(["snippet_not_on_map"]);
    for (const output of [
      "Reviewed. I approved the revision.",
      null,
      { ...oneFinding(), approve: true },
      { summary: "s", findings: [{ ...oneFinding().findings[0], status: "decided" }] },
      { summary: "s", findings: [{ ...oneFinding().findings[0], kind: "delete_step" }] },
      { summary: "s", findings: [{ ...oneFinding().findings[0], proposal: { type: "NEW_PROPOSAL", item: "approval" } }] },
      product,
    ]) {
      const result = resolveReview(product, output, "stub");
      expect(result.ok).toBe(false);
      expect(codes(result).every((c) => c.startsWith("agent_output_"))).toBe(true);
    }
  });

  it("derives ids of proposed items from their text and never collides", () => {
    const review = resolved();
    const ids = review.findings.map((f) => ("id" in f.operation ? f.operation.id : ""));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("wcbc-start-product-cannot-be-completed");
    expect(ids[6]).toMatch(/^dec-who-leads-/);
  });
});

describe("an agent finding cannot change the map without a human", () => {
  it("resolving a review leaves the product untouched", () => {
    const product = loadFixture();
    const before = exportProductYaml(product);
    const review = resolved(product);
    expect(exportProductYaml(product)).toBe(before);
    expect(review).not.toHaveProperty("product");
    expect(review.baseFingerprint).toBe(fingerprint(product));
  });

  it("an accepted finding yields the next proposed revision, never an approved one", () => {
    const approved = approveRevision(loadFixture(), APPROVAL);
    const review = resolved(approved);
    const applied = applyMapPatch(approved, buildReviewPatch(review, ["af-1", "af-6"]));
    if (!applied.ok) throw new Error(JSON.stringify(applied.issues));

    expect(applied.product.revision).toEqual({ number: 2, status: "proposed" });
    expect(applied.product.wcbc.at(-1)).toMatchObject({
      id: "wcbc-start-product-cannot-be-completed",
      stepId: "step-start-product",
      outcome: { kind: "recovery", resumeStepId: "step-start-product" },
    });
    // A finding about existing items can only become an *open* decision.
    expect(applied.product.decisions.at(-1)).toMatchObject({ status: "open", relatesTo: ["step-select-slice", "step-export-work"] });
    expect(applied.product.decisions.filter((d) => d.status === "decided")).toHaveLength(3);
    expect(applied.product.provenance).toHaveLength(2);
    // Only what was ticked was applied.
    expect(applied.product.wcbc).toHaveLength(approved.wcbc.length + 1);
  });

  it("findings made on an older map are refused", () => {
    const product = loadFixture();
    const review = resolved(product);
    const edited = updateCard(product, "step-start-product", { title: "Begin" });
    expect(codes(applyMapPatch(edited, buildReviewPatch(review, ["af-1"])))).toEqual(["stale_patch"]);
  });

  it("accepting nothing is refused", () => {
    expect(codes(applyMapPatch(loadFixture(), buildReviewPatch(resolved(), [])))).toEqual(["empty_patch"]);
  });
});

describe("what a human has to look at before approving", () => {
  it("every open decision is in the findings, as a note that names it; a decided one is not", () => {
    const p = loadFixture();
    const open = p.decisions.filter((d) => d.status === "open");
    const found = reviewNarrative(p).filter((f) => f.code === "unresolved_decision");
    expect(open.length).toBeGreaterThan(0);
    expect(found.map((f) => f.id)).toEqual(open.map((d) => `unresolved_decision:${d.id}`));
    for (const finding of found) {
      const decision = open.find((d) => d.id === finding.relatesTo[0])!;
      expect(finding.level).toBe("note");
      expect(finding.message).toContain(decision.title);
      expect(finding.relatesTo).toEqual([decision.id, ...decision.relatesTo]);
    }
  });

  it("an open decision is not a gap: it does not count against a slice", () => {
    const gaps = reviewNarrative(loadFixture()).filter((f) => f.level === "gap");
    expect(gaps.some((f) => f.code === "unresolved_decision")).toBe(false);
  });

  it("every kind of finding has a plain label, and the kinds a review asks for are among them", () => {
    const labels = Object.values(FINDING_LABEL);
    expect(labels.every((label) => label.trim() !== "")).toBe(true);
    for (const wanted of ["Missing actor", "Missing need", "Unjustified behaviour", "Unresolved decision"]) expect(labels).toContain(wanted);
    expect(FINDING_LABEL.step_without_persona).toBe("Missing actor");
    expect(FINDING_LABEL.persona_without_need).toBe("Missing need");
    expect(FINDING_LABEL.behavior_without_need).toBe("Unjustified behaviour");
    expect(FINDING_LABEL.unresolved_decision).toBe("Unresolved decision");
  });
});
