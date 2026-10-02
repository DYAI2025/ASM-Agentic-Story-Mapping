import { describe, expect, it } from "vitest";
import { buildExecutionBrief } from "../../src/domain/brief";
import { fingerprint } from "../../src/domain/fingerprint";
import { deriveGuide, type GuideState, type GuideStepId } from "../../src/domain/guide";
import { approveRevision, updateCard } from "../../src/domain/operations";
import type { ProductDocument } from "../../src/domain/schema";
import { SLICE_DERIVATION_VERSION, candidateFingerprint, proposeSlices } from "../../src/domain/slices";
import { validateProduct } from "../../src/domain/validate";
import { acceptValueException, resolveSelection, selectSlice, type SliceSelection } from "../../src/domain/work-state";
import { loadFixture, mutableFixture } from "./helpers";

const APPROVAL = { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" };
const approved = (p: ProductDocument = loadFixture()) => approveRevision(p, APPROVAL);
const choose = (p: ProductDocument, candidateId = "slice-outcome-thread") =>
  selectSlice(p, { candidateId, selectedBy: "Maya", selectedAt: "2026-10-02T09:00:00.000Z", mapFingerprint: fingerprint(p) });

/** The fixture with every need removed, and every reference to one. Still a valid document. */
function withoutNeeds(): ProductDocument {
  const p = mutableFixture();
  const gone = new Set(p.needs.map((n) => n.id));
  p.narrative.forEach((s) => (s.needIds = []));
  p.needs = [];
  p.decisions = p.decisions
    .map((d) => ({ ...d, relatesTo: d.relatesTo.filter((id) => !gone.has(id)) }))
    .filter((d) => d.relatesTo.length > 0);
  for (const id of gone) delete p.layout.cards[id];
  return p;
}

const statuses = (g: GuideState) => Object.fromEntries(g.steps.map((s) => [s.id, s.status])) as Record<GuideStepId, string>;
const step = (g: GuideState, id: GuideStepId) => g.steps.find((s) => s.id === id)!;
const impacts = (g: GuideState) => Object.fromEntries(g.impacts.map((i) => [i.id, i.reached]));

/** A selection that looks current for `p` although `p` was never approved. Only a forged work-state file can hold one. */
function forgedSelection(p: ProductDocument): SliceSelection {
  const proposal = proposeSlices(p);
  if (!proposal.ok) throw new Error("fixture yields no candidates");
  const candidate = proposal.candidates.find((c) => c.needIds.length > 0)!;
  return {
    candidateId: candidate.id,
    productId: p.product.id,
    revision: p.revision.number,
    mapFingerprint: fingerprint(p),
    candidateFingerprint: candidateFingerprint(candidate),
    derivationVersion: SLICE_DERIVATION_VERSION,
    selectedBy: "Nobody",
    selectedAt: "2026-10-02T09:00:00.000Z",
  };
}

describe("guide: the current step is the earliest step the real state has not reached", () => {
  it("proposed fixture: the map exists, approval is the current step, nothing later is done", () => {
    const g = deriveGuide(loadFixture(), null);
    expect(g.steps.map((s) => s.id)).toEqual(["intent", "people", "main_path", "approve", "select", "work_order"]);
    expect(statuses(g)).toEqual({
      intent: "done",
      people: "done",
      main_path: "done",
      approve: "current",
      select: "upcoming",
      work_order: "upcoming",
    });
    expect(g.currentStepId).toBe("approve");
    expect(g.doneCount).toBe(3);
  });

  it("exactly one step is current until everything is done", () => {
    const first = approved();
    const states = [deriveGuide(loadFixture(), null), deriveGuide(first, null), deriveGuide(first, choose(first))];
    for (const g of states.slice(0, 2)) expect(g.steps.filter((s) => s.status === "current")).toHaveLength(1);
    expect(states[2].steps.filter((s) => s.status === "current")).toHaveLength(0);
    expect(states[2].currentStepId).toBeNull();
  });

  it("no persona or no need: the people step is current even though a path exists", () => {
    const p = withoutNeeds();
    expect(validateProduct(p).ok).toBe(true);
    const g = deriveGuide(p, null);
    expect(g.currentStepId).toBe("people");
    expect(statuses(g).main_path).toBe("upcoming");
  });

  it("a main path of one step is not a main path yet", () => {
    const p = mutableFixture();
    const keep = p.narrative.find((s) => s.sequence === 1)!;
    p.narrative = [keep];
    p.wcbc = p.wcbc.filter((b) => b.stepId === keep.id);
    p.wcbc.forEach((b) => delete b.outcome);
    const ids = new Set([p.goal.id, keep.id, ...p.personas.map((e) => e.id), ...p.needs.map((e) => e.id), ...p.wcbc.map((b) => b.id)]);
    p.decisions = p.decisions.map((d) => ({ ...d, relatesTo: d.relatesTo.filter((id) => ids.has(id)) })).filter((d) => d.relatesTo.length > 0);
    p.layout = { cards: {} };
    expect(validateProduct(p).ok).toBe(true);
    expect(deriveGuide(p, null).currentStepId).toBe("main_path");
  });

  it("approved, nothing selected: selecting is the current step", () => {
    const g = deriveGuide(approved(), null);
    expect(g.currentStepId).toBe("select");
    expect(statuses(g).approve).toBe("done");
    expect(step(g, "select").stale).toBeUndefined();
  });

  it("approved and selected with a need: every step is done", () => {
    const p = approved();
    const g = deriveGuide(p, choose(p));
    expect(g.currentStepId).toBeNull();
    expect(g.doneCount).toBe(g.steps.length);
  });

  it("selected slice without a need: the work order step stays current until a human accepts the exception", () => {
    const p = mutableFixture();
    p.narrative.forEach((s) => (s.needIds = []));
    const ok = approved(p);
    const selection = choose(ok, "slice-primary-persona");
    const before = deriveGuide(ok, selection);
    expect(before.currentStepId).toBe("work_order");
    expect(statuses(before).select).toBe("done");

    const accepted = acceptValueException(ok, selection, { rationale: "Learning spike.", acceptedBy: "Ada", acceptedAt: "2026-10-02T10:00:00.000Z" });
    expect(deriveGuide(ok, accepted).currentStepId).toBeNull();
  });
});

describe("guide: it cannot get past a human gate", () => {
  it("a selection on a revision nobody approved does not move the guide past approval", () => {
    const p = loadFixture();
    const selection = forgedSelection(p);
    // The existing export gate refuses this state; the guide must not present it as progress.
    expect(buildExecutionBrief(p, selection)).toMatchObject({ ok: false, issues: [{ code: "approval_required" }] });
    const g = deriveGuide(p, selection);
    expect(g.currentStepId).toBe("approve");
    expect(statuses(g).select).not.toBe("done");
    expect(statuses(g).work_order).not.toBe("done");
    expect(impacts(g).delivery).toBe(false);
  });

  it("the guide's last step is done exactly when the export gate lets a work order out", () => {
    const first = approved();
    const edited = updateCard(first, "step-export-work", { description: "Changed after selection." });
    const noNeed = mutableFixture();
    noNeed.narrative.forEach((s) => (s.needIds = []));
    const noNeedApproved = approved(noNeed);
    const cases: [ProductDocument, SliceSelection | null][] = [
      [loadFixture(), null],
      [loadFixture(), forgedSelection(loadFixture())],
      [first, null],
      [first, choose(first)],
      [edited, choose(first)],
      [approved(edited), choose(first)],
      [noNeedApproved, choose(noNeedApproved, "slice-primary-persona")],
      [
        approved(withoutNeeds()),
        acceptValueException(approved(withoutNeeds()), choose(approved(withoutNeeds()), "slice-primary-persona"), {
          rationale: "Learning spike.",
          acceptedBy: "Ada",
          acceptedAt: "2026-10-02T10:00:00.000Z",
        }),
      ],
    ];
    for (const [p, selection] of cases)
      expect(statuses(deriveGuide(p, selection)).work_order === "done").toBe(buildExecutionBrief(p, selection).ok);
  });

});

describe("guide: it does not hide progress the gates have let through", () => {
  it("a map without needs that a human approved, selected and excepted: every step is done", () => {
    const p = approved(withoutNeeds());
    const selection = acceptValueException(p, choose(p, "slice-primary-persona"), {
      rationale: "Learning spike.",
      acceptedBy: "Ada",
      acceptedAt: "2026-10-02T10:00:00.000Z",
    });
    expect(buildExecutionBrief(p, selection).ok).toBe(true);
    const g = deriveGuide(p, selection);
    expect(g.currentStepId).toBeNull();
    // Nobody's need is on the map: the guide follows the approval, and does not claim the needs are there.
    expect(step(g, "people").approvedAsIs).toBe(true);
    expect(impacts(g)).toEqual({ map: false, sensemaking: true, delivery: true });
  });

  it("the same map before approval: the people step is still the current one", () => {
    expect(deriveGuide(withoutNeeds(), null).currentStepId).toBe("people");
  });

  it("the approval marker names who approved, also when the approval came with an imported file", () => {
    const g = deriveGuide(approveRevision(loadFixture(), { approvedBy: "Someone Else", approvedAt: "2026-09-30T08:00:00.000Z" }), null);
    expect(g.impacts.find((i) => i.id === "sensemaking")!.label).toBe("The story is approved (by Someone Else)");
  });
});

describe("guide: a change upstream leads back to the earliest step that has to be redone", () => {
  it("editing an approved map with a selected slice: approval is current again, the selection is shown as stale", () => {
    const first = approved();
    const selection = choose(first);
    const edited = updateCard(first, "step-export-work", { description: "Changed after selection." });
    const g = deriveGuide(edited, selection);
    expect(g.currentStepId).toBe("approve");
    expect(statuses(g).select).toBe("upcoming");
    // The reason only. Telling the human to select again would be wrong here: approval comes first.
    expect(step(g, "select").stale).toBe("the map has changed since the slice was selected");
    expect(impacts(g)).toEqual({ map: true, sensemaking: false, delivery: false });
  });

  it("approved again after the edit: selecting is current and still marked stale, not 'never selected'", () => {
    const first = approved();
    const selection = choose(first);
    const again = approveRevision(updateCard(first, "step-export-work", { description: "Changed." }), APPROVAL);
    const g = deriveGuide(again, selection);
    expect(g.currentStepId).toBe("select");
    expect(step(g, "select").stale).toBeDefined();
    expect(step(deriveGuide(again, null), "select").stale).toBeUndefined();
  });
});

describe("guide: impact markers appear only when the state is reached", () => {
  it("map, then narrative approved, then work order", () => {
    const p = approved();
    expect(impacts(deriveGuide(loadFixture(), null))).toEqual({ map: true, sensemaking: false, delivery: false });
    expect(impacts(deriveGuide(p, null))).toEqual({ map: true, sensemaking: true, delivery: false });
    expect(impacts(deriveGuide(p, choose(p)))).toEqual({ map: true, sensemaking: true, delivery: true });
  });

  it("no map impact while the people step is open", () => {
    expect(impacts(deriveGuide(withoutNeeds(), null)).map).toBe(false);
  });
});

describe("guide: it is a projection", () => {
  it("does not change the product or the selection it reads", () => {
    const p = approved();
    const selection = choose(p);
    const before = JSON.stringify([p, selection]);
    deriveGuide(p, selection);
    expect(JSON.stringify([p, selection])).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Invariants, checked over a grid of maps and selections rather than one case
// each: the guide may never say more than the gates do, and never lead nowhere.

/** The fixture cut down to its first step. Still a valid document. */
function singleStep(): ProductDocument {
  const p = mutableFixture();
  const keep = p.narrative.find((s) => s.sequence === 1)!;
  p.narrative = [keep];
  p.wcbc = p.wcbc.filter((b) => b.stepId === keep.id);
  p.wcbc.forEach((b) => delete b.outcome);
  const ids = new Set([p.goal.id, keep.id, ...p.personas.map((e) => e.id), ...p.needs.map((e) => e.id), ...p.wcbc.map((b) => b.id)]);
  p.decisions = p.decisions.map((d) => ({ ...d, relatesTo: d.relatesTo.filter((id) => ids.has(id)) })).filter((d) => d.relatesTo.length > 0);
  p.layout = { cards: {} };
  return p;
}

/** The fixture with nobody on it: no personas, no needs. Still a valid document. */
function nobody(): ProductDocument {
  const p = withoutNeeds();
  const gone = new Set(p.personas.map((e) => e.id));
  p.personas = [];
  p.narrative.forEach((s) => (s.personaIds = []));
  p.wcbc.forEach((b) => b.outcome?.kind === "escalation" && delete b.outcome);
  p.decisions = p.decisions.map((d) => ({ ...d, relatesTo: d.relatesTo.filter((id) => !gone.has(id)) })).filter((d) => d.relatesTo.length > 0);
  for (const id of gone) delete p.layout.cards[id];
  return p;
}

/** Every selection worth trying on a document: none, each real candidate, with and without exception, and forgeries. */
function selectionsFor(p: ProductDocument): (SliceSelection | null)[] {
  const out: (SliceSelection | null)[] = [null];
  const proposal = proposeSlices(p);
  if (!proposal.ok) return out;
  for (const candidate of proposal.candidates) {
    const forged: SliceSelection = {
      candidateId: candidate.id,
      productId: p.product.id,
      revision: p.revision.number,
      mapFingerprint: fingerprint(p),
      candidateFingerprint: candidateFingerprint(candidate),
      derivationVersion: SLICE_DERIVATION_VERSION,
      selectedBy: "Grid",
      selectedAt: "2026-10-02T09:00:00.000Z",
    };
    const exception = { rationale: "Grid.", acceptedBy: "Grid", acceptedAt: "2026-10-02T10:00:00.000Z" };
    out.push(
      forged,
      { ...forged, valueException: exception },
      { ...forged, productId: "another-product" },
      { ...forged, mapFingerprint: "00000000" },
      { ...forged, candidateFingerprint: "00000000" },
      { ...forged, derivationVersion: SLICE_DERIVATION_VERSION + 1 },
    );
  }
  return out;
}

function grid(): { name: string; product: ProductDocument; selection: SliceSelection | null }[] {
  const bases: [string, () => ProductDocument][] = [
    ["fixture", loadFixture],
    ["without needs", withoutNeeds],
    ["nobody", nobody],
    ["single step", singleStep],
  ];
  const cases: { name: string; product: ProductDocument; selection: SliceSelection | null }[] = [];
  for (const [name, make] of bases) {
    const proposed = make();
    const ok = approved(make());
    const edited = updateCard(ok, ok.goal.id, { statement: "Changed after approval." });
    for (const [state, product] of [["proposed", proposed], ["approved", ok], ["edited after approval", edited]] as const) {
      // Selections made on this document, and selections left over from the approved one.
      for (const selection of [...selectionsFor(product), ...(product === ok ? [] : selectionsFor(ok).slice(1))])
        cases.push({ name: `${name} / ${state} / ${selection ? `${selection.candidateId} ${selection.mapFingerprint}` : "no selection"}`, product, selection });
    }
  }
  return cases;
}

describe("guide: invariants over a grid of maps and selections", () => {
  const cases = grid();

  it("the grid is not trivially small and contains both exportable and refused states", () => {
    expect(validateProduct(nobody()).ok).toBe(true);
    expect(validateProduct(singleStep()).ok).toBe(true);
    expect(cases.length).toBeGreaterThan(150);
    const exportable = cases.filter((c) => buildExecutionBrief(c.product, c.selection).ok).length;
    expect(exportable).toBeGreaterThan(3);
    expect(exportable).toBeLessThan(cases.length / 2);
  });

  it("the last step is done exactly when the export gate lets a work order out", () => {
    for (const c of cases) expect(statuses(deriveGuide(c.product, c.selection)).work_order === "done", c.name).toBe(buildExecutionBrief(c.product, c.selection).ok);
  });

  it("the approval step is done exactly when the revision is approved, and nothing later is done before it", () => {
    for (const c of cases) {
      const s = statuses(deriveGuide(c.product, c.selection));
      expect(s.approve === "done", c.name).toBe(c.product.revision.status === "approved");
      if (s.approve !== "done") expect([s.select, s.work_order], c.name).toEqual(["upcoming", "upcoming"]);
    }
  });

  it("at most one step is current; none only when every step is done; it is the first step that is not done", () => {
    for (const c of cases) {
      const g = deriveGuide(c.product, c.selection);
      const current = g.steps.filter((s) => s.status === "current");
      expect(current.length, c.name).toBe(g.doneCount === g.steps.length ? 0 : 1);
      expect(g.steps.findIndex((s) => s.status !== "done"), c.name).toBe(g.steps.findIndex((s) => s.status === "current"));
    }
  });

  it("no dead end: when the slice step is current and no slice can be derived, it says why and points at the input", () => {
    let seen = 0;
    for (const c of cases) {
      const g = deriveGuide(c.product, c.selection);
      const proposal = proposeSlices(c.product);
      const select = step(g, "select");
      expect(select.blocked === undefined, c.name).toBe(proposal.ok);
      expect(select.action.kind, c.name).toBe(proposal.ok ? "open_slices" : "focus_workshop");
      if (g.currentStepId === "select" && !proposal.ok) {
        seen++;
        expect(select.blocked, c.name).toBe(proposal.issues.map((i) => i.message).join("; "));
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("a step is never shown as present when it is not: it is marked 'approved as it is', and the map marker stays off", () => {
    let seen = 0;
    for (const c of cases) {
      const g = deriveGuide(c.product, c.selection);
      const noPeople = c.product.personas.length === 0 || c.product.needs.length === 0;
      const noPath = c.product.narrative.length < 2;
      expect(step(g, "people").approvedAsIs === true, c.name).toBe(noPeople && c.product.revision.status === "approved");
      expect(step(g, "main_path").approvedAsIs === true, c.name).toBe(noPath && c.product.revision.status === "approved");
      if (noPeople || noPath) {
        seen++;
        expect(impacts(g).map, c.name).toBe(false);
      }
      for (const id of ["approve", "select", "work_order"] as const) expect(step(g, id).approvedAsIs, c.name).toBeUndefined();
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("a stored selection that does not resolve is marked stale on its step, in every state", () => {
    for (const c of cases) {
      const g = deriveGuide(c.product, c.selection);
      const stale = c.selection !== null && !resolveSelection(c.product, c.selection).ok;
      expect(step(g, "select").stale !== undefined, c.name).toBe(stale);
    }
  });
});

describe("guide: wording", () => {
  it("one open point is singular", () => {
    const p = mutableFixture();
    const open = p.wcbc.filter((b) => b.kind === "worst_case" && !b.outcome);
    open.slice(1).forEach((b) => (b.outcome = { kind: "termination" }));
    expect(step(deriveGuide(p, null), "approve").purpose).toContain("1 open point is listed");
    expect(step(deriveGuide(loadFixture(), null), "approve").purpose).toContain("6 open points are listed");
  });
});
