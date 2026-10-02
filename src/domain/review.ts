import { z } from "zod";
import { isPersona } from "./actors";
import { fingerprint } from "./fingerprint";
import { makeId } from "./ids";
import {
  AgentPlacement,
  AgentSource,
  MAX_ITEMS_PER_KIND,
  MAX_TEXT_LENGTH,
  allIds,
  applyMapPatch,
  zodIssues,
  type MapPatch,
  type PatchOperation,
  type Placement,
} from "./map-patch";
import { WcbcKindSchema, type ProductDocument, type WcbcOutcome } from "./schema";
import type { ValidationIssue } from "./validate";

/**
 * Narrative review.
 *
 *   reviewNarrative   deterministic checks. Same map, same findings.
 *   resolveReview     turns untrusted agent output into findings that either
 *                     point at ids on the map or are explicit NEW_PROPOSAL
 *                     items. Nothing here writes anything.
 *   buildReviewPatch  the findings a human ticked, as a MapPatch. It reaches
 *                     the map only through the same accept path as any other
 *                     proposal.
 *
 * Findings are derived, never stored: Canonical != Derived.
 */

// ------------------------------------------------------- deterministic checks

export type FindingCode =
  | "step_without_persona"
  | "behavior_without_need"
  | "main_path_missing"
  | "main_path_single_step"
  | "orphan_need"
  | "orphan_persona"
  | "persona_without_need"
  | "wcbc_without_outcome"
  | "need_persona_not_on_step";

export interface Finding {
  /** `<code>:<id of the first item it is about>`; stable for the same map. */
  id: string;
  code: FindingCode;
  /** A gap is something the narrative is missing; a note is worth a look. */
  level: "gap" | "note";
  message: string;
  /** Ids on the map this finding is about. */
  relatesTo: string[];
}

/**
 * Deterministic review of a valid product document. Duplicate ids and
 * references to ids that do not exist never get this far: `validateProduct`
 * rejects them.
 *
 * The main path's start and end are the steps with the lowest and the highest
 * `sequence`; the schema has no separate start or end marker.
 * A step's "explicit rationale" is a decided decision that relates to it.
 */
export function reviewNarrative(p: ProductDocument): Finding[] {
  const findings: Finding[] = [];
  const add = (code: FindingCode, level: Finding["level"], relatesTo: string[], message: string) =>
    findings.push({ id: `${code}:${relatesTo[0] ?? "map"}`, code, level, message, relatesTo });

  const steps = [...p.narrative].sort((a, b) => a.sequence - b.sequence);
  const needById = new Map(p.needs.map((n) => [n.id, n]));
  const personaName = new Map(p.personas.map((e) => [e.id, e.name]));
  const justified = new Set(
    p.decisions.filter((d) => d.status === "decided" && d.rationale.trim() !== "").flatMap((d) => d.relatesTo),
  );

  if (steps.length === 0)
    add("main_path_missing", "gap", [], "The main path has no steps, so it has neither a start nor an end.");
  else if (steps.length === 1)
    add(
      "main_path_single_step",
      "gap",
      [steps[0].id],
      `The main path is the single step “${steps[0].title}”: its start is also its end.`,
    );

  for (const step of steps) {
    if (step.personaIds.length === 0)
      add("step_without_persona", "gap", [step.id], `Step “${step.title}” has no persona: nobody is said to do it.`);
    if (step.needIds.length === 0 && !justified.has(step.id))
      add(
        "behavior_without_need",
        "gap",
        [step.id],
        `Step “${step.title}” serves no need and no decided decision gives a rationale for it.`,
      );
    for (const needId of step.needIds) {
      const owner = needById.get(needId)?.personaId;
      if (owner && !step.personaIds.includes(owner))
        add(
          "need_persona_not_on_step",
          "note",
          [step.id, needId, owner],
          `Step “${step.title}” serves a need of ${personaName.get(owner) ?? owner}, who does not take part in the step.`,
        );
    }
  }

  const servedNeeds = new Set(steps.flatMap((s) => s.needIds));
  for (const need of p.needs)
    if (!servedNeeds.has(need.id))
      add("orphan_need", "gap", [need.id], `No step serves the need “${need.statement}”.`);

  // Both checks are about personas only. An actor who is not a persona has no modelled need or behaviour to miss.
  // (Everyone on a step is a persona, by validation, so the step checks above need no such filter.)
  const actingPersonas = new Set(steps.flatMap((s) => s.personaIds));
  const needOwners = new Set(p.needs.map((n) => n.personaId));
  for (const persona of p.personas.filter(isPersona)) {
    if (!actingPersonas.has(persona.id))
      add("orphan_persona", "gap", [persona.id], `Persona “${persona.name}” takes part in no step.`);
    if (!needOwners.has(persona.id))
      add(
        "persona_without_need",
        "gap",
        [persona.id],
        `Persona “${persona.name}” has no need on the map. This is unresolved: a human has to say what they need, or that they are not a persona.`,
      );
  }

  for (const branch of p.wcbc)
    if (branch.kind === "worst_case" && !branch.outcome)
      add(
        "wcbc_without_outcome",
        "gap",
        [branch.id, branch.stepId],
        `Worst case “${branch.title}” does not say where it leads: no recovery step, termination or escalation is referenced.`,
      );

  return findings;
}

// ---------------------------------------------------------------- agent output

export const AGENT_FINDING_KINDS = [
  "missing_transition",
  "missing_wcbc",
  "conflicting_descriptions",
  "implementation_wording",
  "missing_product_question",
] as const;

export type AgentFindingKind = (typeof AGENT_FINDING_KINDS)[number];

const AgentOutcome = z.strictObject({
  kind: z.enum(["recovery", "termination", "escalation"]),
  /** Existing step id when kind is "recovery"; otherwise null. */
  step: z.string().nullable(),
  /** Existing persona id when kind is "escalation"; otherwise null. */
  persona: z.string().nullable(),
});

const NewProposal = z.discriminatedUnion("item", [
  z.strictObject({
    type: z.literal("NEW_PROPOSAL"),
    item: z.literal("step"),
    title: z.string(),
    description: z.string(),
    personas: z.array(z.string()),
    needs: z.array(z.string()),
    placement: AgentPlacement,
  }),
  z.strictObject({
    type: z.literal("NEW_PROPOSAL"),
    item: z.literal("wcbc"),
    step: z.string(),
    kind: WcbcKindSchema,
    title: z.string(),
    description: z.string(),
    recovery: z.string(),
    outcome: AgentOutcome,
  }),
  z.strictObject({ type: z.literal("NEW_PROPOSAL"), item: z.literal("question"), question: z.string() }),
]);

/**
 * What a review provider returns. Untrusted. Closed schema, structural types
 * only, so it can double as a provider's output contract.
 *
 * A finding is about ids that exist on the map (`relatesTo`), or it carries an
 * explicit NEW_PROPOSAL, or both. There is no third way to say something.
 */
export const AgentReviewOutputSchema = z.strictObject({
  summary: z.string(),
  findings: z.array(
    z.strictObject({
      kind: z.enum(AGENT_FINDING_KINDS),
      message: z.string(),
      relatesTo: z.array(z.string()),
      /** `snippet` is a verbatim quote from the map, not from anywhere else. */
      evidence: AgentSource,
      proposal: NewProposal.nullable(),
    }),
  ),
});

export type AgentReviewOutput = z.infer<typeof AgentReviewOutputSchema>;

// --------------------------------------------------------------- resolved review

export interface AgentFinding {
  findingId: string;
  kind: AgentFindingKind;
  message: string;
  relatesTo: string[];
  /** "existing": about ids on the map only. "NEW_PROPOSAL": proposes something that is not on the map. */
  origin: "existing" | "NEW_PROPOSAL";
  /** What accepting this finding would do. Nothing happens until a human accepts it. */
  operation: PatchOperation;
}

export interface NarrativeReview {
  provider: string;
  /** Fingerprint of the map the review was made against. */
  baseFingerprint: string;
  baseRevision: number;
  summary: string;
  findings: AgentFinding[];
}

export type ReviewResult = { ok: true; review: NarrativeReview } | { ok: false; issues: ValidationIssue[] };

const normalizeSpace = (text: string) => text.replace(/\s+/g, " ").trim();

/** Every piece of text on the map, for checking that quoted evidence is real. */
function mapText(p: ProductDocument): string {
  return normalizeSpace(
    [
      p.product.name,
      p.product.summary,
      p.goal.statement,
      ...p.personas.flatMap((e) => [e.name, e.description]),
      ...p.needs.map((e) => e.statement),
      ...p.narrative.flatMap((e) => [e.title, e.description]),
      ...p.wcbc.flatMap((e) => [e.title, e.description, e.recovery]),
      ...p.decisions.flatMap((e) => [e.title, e.rationale]),
    ].join("\n"),
  );
}

/**
 * Turn raw review output into findings, or into the reasons why not.
 * Checked here: shape, text limits, that quoted evidence really occurs on the
 * map, that every id exists on the map as it is now (an id from an older map
 * is as unknown as an invented one), and that every finding is anchored.
 * Ids of proposed items are derived from their text, never taken from the agent.
 */
export function resolveReview(product: ProductDocument, rawOutput: unknown, provider: string): ReviewResult {
  const parsed = AgentReviewOutputSchema.safeParse(rawOutput);
  if (!parsed.success) return { ok: false, issues: sort(zodIssues("agent_output", parsed.error)) };
  const out = parsed.data;

  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  if (out.findings.length > MAX_ITEMS_PER_KIND)
    return { ok: false, issues: [{ code: "too_many_items", path: "findings", message: `at most ${MAX_ITEMS_PER_KIND} findings per review` }] };

  const haystack = mapText(product);
  const known = allIds(product);
  const taken = allIds(product);
  const personas = new Set(product.personas.map((e) => e.id));
  const needs = new Set(product.needs.map((e) => e.id));
  const steps = new Set(product.narrative.map((e) => e.id));

  const text = (path: string, value: string, required = true): string => {
    const trimmed = value.trim();
    if (required && trimmed === "") add("empty_text", path, "must not be empty");
    if (trimmed.length > MAX_TEXT_LENGTH) add("text_too_long", path, `at most ${MAX_TEXT_LENGTH} characters`);
    return trimmed;
  };
  const existing = (set: Set<string>, what: string, path: string, id: string): string => {
    if (!set.has(id)) add("unknown_id", path, `${what} "${id}" does not exist on the map`);
    return id;
  };

  const findings: AgentFinding[] = out.findings.map((finding, i) => {
    const path = `findings[${i}]`;
    const message = text(`${path}.message`, finding.message);
    const relatesTo = finding.relatesTo.map((id, j) => existing(known, "id", `${path}.relatesTo[${j}]`, id));
    if (relatesTo.length === 0 && !finding.proposal)
      add("unanchored_finding", path, "a finding must reference ids on the map or be an explicit NEW_PROPOSAL");

    const snippet = text(`${path}.evidence.snippet`, finding.evidence.snippet);
    if (snippet !== "" && !haystack.includes(normalizeSpace(snippet)))
      add("snippet_not_on_map", `${path}.evidence.snippet`, "the quoted evidence does not occur on the map");
    if (!(finding.evidence.confidence >= 0 && finding.evidence.confidence <= 1))
      add("invalid_confidence", `${path}.evidence.confidence`, "confidence must be between 0 and 1");
    const base = {
      opId: `op-${i + 1}`,
      source: {
        snippet,
        rationale: text(`${path}.evidence.rationale`, finding.evidence.rationale, false),
        confidence: finding.evidence.confidence,
      },
    };

    const proposal = finding.proposal;
    let operation: PatchOperation;
    if (!proposal) {
      // A finding about existing items can only ever be recorded as an open question.
      operation = { ...base, op: "add_question", id: makeId("decision", message, taken), question: message, relatesTo };
    } else if (proposal.item === "question") {
      const question = text(`${path}.proposal.question`, proposal.question);
      operation = { ...base, op: "add_question", id: makeId("decision", question, taken), question, relatesTo };
    } else if (proposal.item === "step") {
      const title = text(`${path}.proposal.title`, proposal.title);
      let placement: Placement = { kind: "end" };
      if (proposal.placement.kind === "after") {
        if (proposal.placement.step === null) add("invalid_placement", `${path}.proposal.placement`, `placement "after" must name a step`);
        else placement = { kind: "after", stepId: existing(steps, "step", `${path}.proposal.placement.step`, proposal.placement.step) };
      } else {
        if (proposal.placement.step !== null)
          add("invalid_placement", `${path}.proposal.placement`, `placement "${proposal.placement.kind}" must not name a step`);
        placement = { kind: proposal.placement.kind };
      }
      operation = {
        ...base,
        op: "add_step",
        id: makeId("step", title, taken),
        title,
        description: text(`${path}.proposal.description`, proposal.description, false),
        personaIds: proposal.personas.map((id, j) => existing(personas, "persona", `${path}.proposal.personas[${j}]`, id)),
        needIds: proposal.needs.map((id, j) => existing(needs, "need", `${path}.proposal.needs[${j}]`, id)),
        placement,
      };
    } else {
      const title = text(`${path}.proposal.title`, proposal.title);
      const o = proposal.outcome;
      let outcome: WcbcOutcome = { kind: "termination" };
      const stray = (field: "step" | "persona") =>
        add("invalid_outcome", `${path}.proposal.outcome`, `outcome "${o.kind}" must not name a ${field}`);
      if (o.kind === "recovery") {
        if (o.persona !== null) stray("persona");
        if (o.step === null) add("invalid_outcome", `${path}.proposal.outcome`, `outcome "recovery" must name the step the path resumes at`);
        else outcome = { kind: "recovery", resumeStepId: existing(steps, "step", `${path}.proposal.outcome.step`, o.step) };
      } else if (o.kind === "escalation") {
        if (o.step !== null) stray("step");
        if (o.persona === null) add("invalid_outcome", `${path}.proposal.outcome`, `outcome "escalation" must name the persona who takes over`);
        else outcome = { kind: "escalation", toPersonaId: existing(personas, "persona", `${path}.proposal.outcome.persona`, o.persona) };
      } else {
        if (o.step !== null) stray("step");
        if (o.persona !== null) stray("persona");
      }
      operation = {
        ...base,
        op: "add_wcbc",
        id: makeId("wcbc", title, taken),
        stepId: existing(steps, "step", `${path}.proposal.step`, proposal.step),
        kind: proposal.kind,
        title,
        description: text(`${path}.proposal.description`, proposal.description, false),
        recovery: text(`${path}.proposal.recovery`, proposal.recovery, false),
        outcome,
      };
    }

    return {
      findingId: `af-${i + 1}`,
      kind: finding.kind,
      message,
      relatesTo,
      origin: proposal ? "NEW_PROPOSAL" : "existing",
      operation,
    };
  });

  if (issues.length > 0) return { ok: false, issues: sort(issues) };

  const review: NarrativeReview = {
    provider,
    baseFingerprint: fingerprint(product),
    baseRevision: product.revision.number,
    summary: out.summary.trim().slice(0, MAX_TEXT_LENGTH),
    findings,
  };

  // Dry run: a finding that could not be accepted as it stands is not shown as one.
  if (findings.length > 0) {
    const dryRun = applyMapPatch(product, buildReviewPatch(review, findings.map((f) => f.findingId)));
    if (!dryRun.ok) return { ok: false, issues: dryRun.issues };
  }
  return { ok: true, review };
}

function sort(issues: ValidationIssue[]): ValidationIssue[] {
  return [...issues].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
}

/**
 * The findings a human chose, as a proposal. This is still only a proposal:
 * `applyMapPatch` checks it again and refuses it if the map has changed.
 */
export function buildReviewPatch(review: NarrativeReview, findingIds: readonly string[]): MapPatch {
  const chosen = new Set(findingIds);
  return {
    patchVersion: 1,
    provider: review.provider,
    baseFingerprint: review.baseFingerprint,
    baseRevision: review.baseRevision,
    summary: review.summary,
    operations: review.findings.filter((f) => chosen.has(f.findingId)).map((f) => f.operation),
  };
}
