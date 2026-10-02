import { hashText } from "./fingerprint";
import { reviewNarrative } from "./review";
import type { NarrativeStep, ProductDocument } from "./schema";
import { validateProduct, type ValidationIssue } from "./validate";

/**
 * First product slice: candidates, never a choice.
 *
 * Candidates are computed from the map alone, by three fixed readings of it.
 * Each one explains itself with what the map says (ids, counts, open
 * decisions). There is no score and no ranking: the order of candidates
 * carries no meaning, and nothing here selects one.
 *
 * Candidates are derived and never stored. A human's selection of one is work
 * state, kept apart from the product document (`work-state.ts`).
 */

/**
 * Version of the rules below that turn a map into candidates. Raise it with
 * every change to those rules: a selection made under another version is stale.
 */
export const SLICE_DERIVATION_VERSION = 1 as const;

export interface AcceptanceCriterion {
  text: string;
  /** Ids on the map the criterion is derived from. */
  refs: string[];
}

export interface SliceFlag {
  code: "missing_need_reference";
  message: string;
}

/** Facts about a candidate, side by side comparable. Counts, not a score. */
export interface SliceEvidence {
  stepCount: number;
  totalSteps: number;
  includesStart: boolean;
  includesEnd: boolean;
  /** How many of the included steps the map's primary persona takes part in. */
  primaryPersonaSteps: number;
  /** Included steps that involve more than one persona. */
  sharedSteps: number;
  needsServed: number;
  totalNeeds: number;
  worstCaseIds: string[];
  openDecisionIds: string[];
  reviewGapIds: string[];
}

export interface SliceCandidate {
  id: string;
  title: string;
  goalId: string;
  stepIds: string[];
  personaIds: string[];
  needIds: string[];
  whyNow: string[];
  assumptions: string[];
  unresolvedQuestions: string[];
  acceptanceCriteria: string[];
  outOfScope: string[];
  evidence: SliceEvidence;
  flags: SliceFlag[];
}

export type SliceProposal = { ok: true; candidates: SliceCandidate[] } | { ok: false; issues: ValidationIssue[] };

const ordered = (p: ProductDocument) => [...p.narrative].sort((a, b) => a.sequence - b.sequence);
const quote = (text: string) => `“${text}”`;
const list = (ids: string[]) => ids.join(", ");

/**
 * The persona who takes part in the most steps; the first one listed wins a
 * tie. Everyone on a step is a persona: validation refuses a map that puts an
 * actor who is not one on a step.
 */
function primaryPersona(p: ProductDocument) {
  let best: { id: string; name: string; steps: number } | null = null;
  for (const persona of p.personas) {
    const steps = p.narrative.filter((s) => s.personaIds.includes(persona.id)).length;
    if (steps > 0 && (!best || steps > best.steps)) best = { id: persona.id, name: persona.name, steps };
  }
  return best;
}

/** Draft criteria for a set of steps, in narrative order. */
export function criteriaFor(p: ProductDocument, stepIds: readonly string[]): AcceptanceCriterion[] {
  const personaName = new Map(p.personas.map((e) => [e.id, e.name]));
  const included = new Set(stepIds);
  const criteria: AcceptanceCriterion[] = [];
  for (const step of ordered(p).filter((s) => included.has(s.id))) {
    const who = step.personaIds.map((id) => personaName.get(id) ?? id).join(" / ") || "Someone (no persona on the map)";
    criteria.push({
      text: `[${step.id}] ${who} can complete ${quote(step.title)}${step.description ? `: ${step.description}` : "."}`,
      refs: [step.id, ...step.personaIds],
    });
    for (const branch of p.wcbc.filter((b) => b.stepId === step.id && b.kind === "worst_case")) {
      const then = branch.recovery.trim() || "what happens next is not described on the map.";
      criteria.push({ text: `[${branch.id}] When ${quote(branch.title)}, then: ${then}`, refs: [branch.id, step.id] });
    }
  }
  return criteria;
}

function build(p: ProductDocument, id: string, title: string, basis: string, chosen: NarrativeStep[]): SliceCandidate {
  const all = ordered(p);
  const start = all[0];
  const end = all[all.length - 1];
  const included = new Set(chosen.map((s) => s.id));
  const steps = all.filter((s) => included.has(s.id));
  const stepIds = steps.map((s) => s.id);
  const personaIds = p.personas.filter((e) => steps.some((s) => s.personaIds.includes(e.id))).map((e) => e.id);
  const needIds = p.needs.filter((e) => steps.some((s) => s.needIds.includes(e.id))).map((e) => e.id);
  const branches = p.wcbc.filter((b) => included.has(b.stepId));
  const worstCaseIds = branches.filter((b) => b.kind === "worst_case").map((b) => b.id);

  const touched = new Set([p.goal.id, ...stepIds, ...personaIds, ...needIds, ...branches.map((b) => b.id)]);
  const openDecisions = p.decisions.filter((d) => d.status === "open" && d.relatesTo.some((ref) => touched.has(ref)));
  const sliceItems = new Set([...stepIds, ...branches.map((b) => b.id)]);
  const gaps = reviewNarrative(p).filter((f) => f.level === "gap" && f.relatesTo.some((ref) => sliceItems.has(ref)));

  const primary = primaryPersona(p);
  const primarySteps = primary ? steps.filter((s) => s.personaIds.includes(primary.id)).length : 0;
  const sharedSteps = steps.filter((s) => s.personaIds.length > 1).length;
  const includesStart = included.has(start.id);
  const includesEnd = included.has(end.id);

  const whyNow = [basis];
  if (primary)
    whyNow.push(
      `Primary persona relevance: ${primary.name} (${primary.id}) takes part in ${primarySteps} of the ${steps.length} included steps.`,
    );
  whyNow.push(`Persona overlap: ${sharedSteps} of the ${steps.length} included steps involve more than one persona.`);
  if (needIds.length > 0) whyNow.push(`Need relation: serves ${needIds.length} of ${p.needs.length} needs (${list(needIds)}).`);
  if (includesStart && includesEnd)
    whyNow.push(`Main-path completeness: includes both the start ${quote(start.title)} and the end ${quote(end.title)}.`);
  else if (includesStart) whyNow.push(`Main-path completeness: begins at the start of the main path, ${quote(start.title)}.`);
  else if (includesEnd) whyNow.push(`Main-path completeness: reaches the end of the main path, ${quote(end.title)}.`);
  whyNow.push(`Scope: ${steps.length} of ${all.length} main-path steps, with ${worstCaseIds.length} worst-case branch(es) to handle.`);
  if (openDecisions.length === 0 && gaps.length === 0) whyNow.push("Readiness: no open decision and no review gap touches this slice.");

  const assumptions: string[] = [];
  if (!includesStart) assumptions.push(`Assumes ${quote(start.title)} [${start.id}] has already happened outside this slice.`);
  const first = steps[0].sequence;
  const last = steps[steps.length - 1].sequence;
  const skipped = all.filter((s) => s.sequence > first && s.sequence < last && !included.has(s.id));
  if (skipped.length > 0)
    assumptions.push(`Assumes the steps skipped between included steps are done by hand: ${skipped.map((s) => `[${s.id}]`).join(" ")}.`);
  if (!includesEnd) assumptions.push(`Does not reach ${quote(end.title)} [${end.id}]: the outcome of this slice is an intermediate one.`);
  assumptions.push(
    needIds.length > 0
      ? `Assumes the included needs contribute to the goal [${p.goal.id}]; the map relates steps to needs, not needs to the goal.`
      : `Assumes these steps contribute to the goal [${p.goal.id}]; none of them names a need.`,
  );

  const outOfScope = [
    ...all.filter((s) => !included.has(s.id)).map((s) => `[${s.id}] ${s.title}`),
    ...p.needs.filter((n) => !needIds.includes(n.id)).map((n) => `[${n.id}] Need not served by this slice: ${n.statement}`),
  ];

  const flags: SliceFlag[] =
    needIds.length === 0
      ? [{ code: "missing_need_reference", message: "None of the included steps references a need: the map gives no reason for this slice." }]
      : [];

  return {
    id,
    title,
    goalId: p.goal.id,
    stepIds,
    personaIds,
    needIds,
    whyNow,
    assumptions,
    unresolvedQuestions: [
      ...openDecisions.map((d) => `[${d.id}] ${d.title}`),
      ...gaps.map((f) => `[${f.relatesTo[0]}] ${f.message}`),
    ],
    acceptanceCriteria: criteriaFor(p, stepIds).map((c) => c.text),
    outOfScope,
    evidence: {
      stepCount: steps.length,
      totalSteps: all.length,
      includesStart,
      includesEnd,
      primaryPersonaSteps: primarySteps,
      sharedSteps,
      needsServed: needIds.length,
      totalNeeds: p.needs.length,
      worstCaseIds,
      openDecisionIds: openDecisions.map((d) => d.id),
      reviewGapIds: gaps.map((f) => f.id),
    },
    flags,
  };
}

/**
 * Two or three candidates, or the reason there are none. Three fixed readings
 * of the map; a reading that yields no steps, or the same steps as an earlier
 * one, is dropped rather than padded.
 */
export function proposeSlices(p: ProductDocument): SliceProposal {
  const all = ordered(p);
  if (all.length < 2)
    return {
      ok: false,
      issues: [{ code: "narrative_too_short", path: "narrative", message: "slice candidates need a main path of at least two steps" }],
    };
  const end = all[all.length - 1];
  const primary = primaryPersona(p);

  const readings: { id: string; title: string; basis: string; steps: NarrativeStep[] }[] = [];
  if (primary)
    readings.push({
      id: "slice-primary-persona",
      title: `${primary.name} path`,
      basis: `${primary.name} (${primary.id}) takes part in ${primary.steps} of ${all.length} main-path steps, more than any other persona; this slice is exactly those steps.`,
      steps: all.filter((s) => s.personaIds.includes(primary.id)),
    });
  readings.push({
    id: "slice-outcome-thread",
    title: `Thread to ${quote(end.title)}`,
    basis:
      end.needIds.length > 0
        ? `The last step ${quote(end.title)} (${end.id}) serves ${list(end.needIds)}; this slice is every step that serves one of those needs.`
        : `The last step ${quote(end.title)} (${end.id}) names no need, so this thread has nothing to follow.`,
    steps: all.filter((s) => s.needIds.some((id) => end.needIds.includes(id))),
  });
  readings.push({
    id: "slice-shared-steps",
    title: "Steps shared between personas",
    basis: "This slice is every step that more than one persona takes part in: the places where work passes between people.",
    steps: all.filter((s) => s.personaIds.length > 1),
  });

  const seen = new Set<string>();
  const candidates: SliceCandidate[] = [];
  for (const reading of readings) {
    const key = reading.steps.map((s) => s.id).join(" ");
    if (reading.steps.length === 0 || seen.has(key)) continue;
    seen.add(key);
    candidates.push(build(p, reading.id, reading.title, reading.basis, reading.steps));
  }

  if (candidates.length < 2)
    return {
      ok: false,
      issues: [
        {
          code: "too_few_candidates",
          path: "narrative",
          message: `the map supports only ${candidates.length} distinct slice candidate(s); personas and needs on the steps are what candidates are derived from`,
        },
      ],
    };
  return { ok: true, candidates };
}

/**
 * Deterministic fingerprint of everything in a candidate that an execution
 * brief is built from or that a human decided on: its steps, personas and
 * needs, the reasons, assumptions, open questions, criteria, scope boundary,
 * the facts shown for comparison and the flags. Fixed key order.
 */
export function candidateFingerprint(c: SliceCandidate): string {
  const e = c.evidence;
  return hashText(
    JSON.stringify({
      id: c.id,
      title: c.title,
      goalId: c.goalId,
      stepIds: c.stepIds,
      personaIds: c.personaIds,
      needIds: c.needIds,
      whyNow: c.whyNow,
      assumptions: c.assumptions,
      unresolvedQuestions: c.unresolvedQuestions,
      acceptanceCriteria: c.acceptanceCriteria,
      outOfScope: c.outOfScope,
      evidence: {
        stepCount: e.stepCount,
        totalSteps: e.totalSteps,
        includesStart: e.includesStart,
        includesEnd: e.includesEnd,
        primaryPersonaSteps: e.primaryPersonaSteps,
        sharedSteps: e.sharedSteps,
        needsServed: e.needsServed,
        totalNeeds: e.totalNeeds,
        worstCaseIds: e.worstCaseIds,
        openDecisionIds: e.openDecisionIds,
        reviewGapIds: e.reviewGapIds,
      },
      flags: c.flags.map((f) => f.code),
    }),
  );
}

export interface SliceCheck {
  /** Reasons the candidate is rejected. */
  issues: ValidationIssue[];
  /** Reasons to look twice. A flagged candidate can still be selected by a human. */
  flags: SliceFlag[];
}

/**
 * Checks any candidate, wherever it came from, against the map as it is now.
 * A candidate without the goal, without steps, or naming an id that is not on
 * the map is rejected. A candidate without any need is flagged.
 */
export function checkSliceCandidate(
  p: ProductDocument,
  candidate: Pick<SliceCandidate, "goalId" | "stepIds" | "personaIds" | "needIds">,
): SliceCheck {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });

  if (candidate.goalId !== p.goal.id)
    add("missing_goal_reference", "goalId", `a slice must reference the product goal "${p.goal.id}"`);
  if (candidate.stepIds.length === 0) add("empty_slice", "stepIds", "a slice needs at least one narrative step");

  const refs = [
    ["stepIds", "step", p.narrative],
    ["personaIds", "persona", p.personas],
    ["needIds", "need", p.needs],
  ] as const;
  for (const [field, what, items] of refs) {
    const known = new Set(items.map((e) => e.id));
    candidate[field].forEach((id, i) => {
      if (!known.has(id)) add("unknown_id", `${field}[${i}]`, `${what} "${id}" does not exist on the map`);
    });
  }

  const flags: SliceFlag[] =
    candidate.needIds.length === 0
      ? [{ code: "missing_need_reference", message: "None of the included steps references a need: the map gives no reason for this slice." }]
      : [];
  return { issues, flags };
}
