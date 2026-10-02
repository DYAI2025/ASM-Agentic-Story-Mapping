import { describe, expect, it } from "vitest";
import { buildExecutionBrief } from "../../src/domain/brief";
import { fingerprint } from "../../src/domain/fingerprint";
import { deriveGuide, type GuideState, type GuideStepId } from "../../src/domain/guide";
import { approveRevision, updateCard } from "../../src/domain/operations";
import type { ProductDocument } from "../../src/domain/schema";
import { SLICE_DERIVATION_VERSION, candidateFingerprint, proposeSlices } from "../../src/domain/slices";
import { validateProduct } from "../../src/domain/validate";
import { acceptValueException, selectSlice, type SliceSelection } from "../../src/domain/work-state";
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
    expect(impacts(g)).toEqual({ map: true, sensemaking: true, delivery: true });
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
