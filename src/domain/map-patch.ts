import { z } from "zod";
import { SourceIdSchema, bundleFromTranscript, type ContextBundle } from "./context";
import { ID_PREFIX, hasPrefix, makeId, type IdKind } from "./ids";
import { fingerprint } from "./fingerprint";
import { ROLE_LABEL } from "./actors";
import {
  IdSchema,
  ValueChainRoleSchema,
  WcbcKindSchema,
  WcbcOutcomeSchema,
  type ProductDocument,
  type Provenance,
  type ValueChainRole,
} from "./schema";
import { validateProduct, type ValidationIssue } from "./validate";

/**
 * Conversation -> proposal -> canon.
 *
 *   AgentOutput  what a provider returns. Untrusted. Closed schema.
 *   MapPatch     a resolved, validated proposal with deterministic ids.
 *                Still only a proposal: nothing here writes anything.
 *   applyMapPatch  the one function that turns an accepted patch into a new
 *                  proposed revision. Pure; the caller decides whether to save.
 *
 * Neither schema has any way to express "approve", "decided" or "delete":
 * an agent cannot propose what the schema cannot say.
 */

// ---------------------------------------------------------------- agent output

export const AgentSource = z.strictObject({
  /** Verbatim quote from the pasted text that this item is based on. */
  snippet: z.string(),
  /** Why the agent proposes this. */
  rationale: z.string(),
  /** 0..1. Advisory only. */
  confidence: z.number(),
  /** Which source of the context bundle the snippet is quoted from. Implied when there is only one; null and absent are the same. */
  sourceId: z.string().nullish(),
});

export const AgentPlacement = z.strictObject({
  kind: z.enum(["start", "end", "after"]),
  /** Step id or `new:` ref when kind is "after"; otherwise null. */
  step: z.string().nullable(),
});

/**
 * Structural types only (no length or range keywords) so the same schema can
 * be handed to a provider as its output contract. Lengths, ranges and
 * references are checked in `resolveProposal`.
 *
 * References are either an existing id from the map or a `new:<name>` ref
 * declared by another item in the same output.
 */
export const AgentOutputSchema = z.strictObject({
  summary: z.string(),
  goal: z.strictObject({ statement: z.string(), source: AgentSource }).nullable(),
  /**
   * Other plausible readings of what the product is for, when the text
   * supports more than one. Shown next to `goal` as a choice the human makes;
   * never chosen by anyone else. Empty when there is one reading.
   */
  goalAlternatives: z.array(z.strictObject({ statement: z.string(), source: AgentSource })).nullish(),
  personas: z.array(
    z.strictObject({
      ref: z.string(),
      name: z.string(),
      description: z.string(),
      /** Value-chain roles the text states for this actor; empty when it states none. */
      roles: z.array(z.string()),
      /** Whether the actor's needs and behaviour are modelled. Always said; never implied by a role. */
      persona: z.boolean(),
      source: AgentSource,
    }),
  ),
  needs: z.array(
    z.strictObject({ ref: z.string(), persona: z.string(), statement: z.string(), source: AgentSource }),
  ),
  steps: z.array(
    z.strictObject({
      ref: z.string(),
      title: z.string(),
      description: z.string(),
      personas: z.array(z.string()),
      needs: z.array(z.string()),
      placement: AgentPlacement,
      source: AgentSource,
    }),
  ),
  assignments: z.array(z.strictObject({ step: z.string(), persona: z.string(), source: AgentSource })),
  moves: z.array(z.strictObject({ step: z.string(), placement: AgentPlacement, source: AgentSource })),
  unresolvedQuestions: z.array(
    z.strictObject({ question: z.string(), relatesTo: z.array(z.string()), source: AgentSource }),
  ),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;

// -------------------------------------------------------------------- MapPatch

export const MAX_TEXT_LENGTH = 600;
export const MAX_ITEMS_PER_KIND = 40;

const Text = z.string().trim().min(1, "must not be empty").max(MAX_TEXT_LENGTH);
const OptionalText = z.string().max(MAX_TEXT_LENGTH);

export const PatchSourceSchema = z.strictObject({
  snippet: Text,
  rationale: OptionalText,
  confidence: z.number().min(0).max(1),
  /** The source the snippet occurs in; resolved, never taken from the provider unchecked. Absent on patches from before bundles. */
  sourceId: SourceIdSchema.optional(),
  sourceLabel: Text.optional(),
});

export const PlacementSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("start") }),
  z.strictObject({ kind: z.literal("end") }),
  z.strictObject({ kind: z.literal("after"), stepId: IdSchema }),
]);

const opBase = { opId: z.string().regex(/^op-\d+$/), source: PatchSourceSchema };

export const PatchOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    ...opBase,
    op: z.literal("set_goal"),
    statement: Text,
    /** Present when this goal is one of several the proposal offers: the human keeps exactly one. */
    choice: z.literal("goal").optional(),
  }),
  z.strictObject({
    ...opBase,
    op: z.literal("add_persona"),
    id: IdSchema,
    name: Text,
    description: OptionalText,
    roles: z.array(ValueChainRoleSchema).optional(),
    /** Absent means persona, as for every entry on the map. */
    persona: z.boolean().optional(),
  }),
  z.strictObject({ ...opBase, op: z.literal("add_need"), id: IdSchema, personaId: IdSchema, statement: Text }),
  z.strictObject({
    ...opBase,
    op: z.literal("add_step"),
    id: IdSchema,
    title: Text,
    description: OptionalText,
    personaIds: z.array(IdSchema),
    needIds: z.array(IdSchema),
    placement: PlacementSchema,
  }),
  z.strictObject({ ...opBase, op: z.literal("assign_persona"), stepId: IdSchema, personaId: IdSchema }),
  z.strictObject({ ...opBase, op: z.literal("move_step"), stepId: IdSchema, placement: PlacementSchema }),
  z.strictObject({
    ...opBase,
    op: z.literal("add_question"),
    id: IdSchema,
    question: Text,
    relatesTo: z.array(IdSchema),
  }),
  z.strictObject({
    ...opBase,
    op: z.literal("add_wcbc"),
    id: IdSchema,
    stepId: IdSchema,
    kind: WcbcKindSchema,
    title: Text,
    description: OptionalText,
    recovery: OptionalText,
    outcome: WcbcOutcomeSchema.optional(),
  }),
]);

export const MapPatchSchema = z.strictObject({
  patchVersion: z.literal(1),
  provider: Text,
  /** Fingerprint of the map the proposal was built against. */
  baseFingerprint: z.string().regex(/^[0-9a-f]{8}$/),
  /** 0 only for a proposal built against the blank draft of a first product (`bootstrap.ts`). */
  baseRevision: z.number().int().min(0),
  summary: OptionalText,
  operations: z.array(PatchOperationSchema).max(MAX_ITEMS_PER_KIND * 6),
});

export type Placement = z.infer<typeof PlacementSchema>;
export type PatchOperation = z.infer<typeof PatchOperationSchema>;
export type MapPatch = z.infer<typeof MapPatchSchema>;

/** Text fields a human may edit on a proposed operation before accepting it. */
export const EDITABLE_OP_FIELDS: Record<PatchOperation["op"], readonly string[]> = {
  set_goal: ["statement"],
  add_persona: ["name", "description"],
  add_need: ["statement"],
  add_step: ["title", "description"],
  assign_persona: [],
  move_step: [],
  add_question: ["question"],
  add_wcbc: ["title", "description", "recovery"],
};

// --------------------------------------------------------------------- helpers

type Issues = ValidationIssue[];

export function zodIssues(prefix: string, error: z.ZodError): Issues {
  return error.issues.map((issue) => ({
    code: `${prefix}_${issue.code}`,
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
}

function sorted(issues: Issues): Issues {
  return [...issues].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
}

const normalizeSpace = (text: string) => text.replace(/\s+/g, " ").trim();

export function allIds(p: ProductDocument): Set<string> {
  return new Set([
    p.product.id,
    p.goal.id,
    ...p.personas.map((e) => e.id),
    ...p.needs.map((e) => e.id),
    ...p.narrative.map((e) => e.id),
    ...p.wcbc.map((e) => e.id),
    ...p.decisions.map((e) => e.id),
  ]);
}

// ------------------------------------------------------------ resolve proposal

/**
 * A refusal from the dry run (applying the proposal to the map) says so with `stage: "apply"`; a refusal of the
 * answer itself (its shape, its items) has no stage. The issues are the same either way; the tag only tells the
 * caller which check refused (ASM-29: only the answer's own problems are named in a repair request).
 */
export type ProposalResult = { ok: true; patch: MapPatch } | { ok: false; issues: Issues; stage?: "apply" };

/**
 * Turn raw provider output into a MapPatch, or into a list of reasons why
 * not. Everything a provider says is checked here: shape, text limits,
 * that every quoted snippet really occurs in the source it is attributed to,
 * and that every reference points at something that exists. Ids for new items
 * are derived from their text, never taken from the provider.
 *
 * The context is a bundle of sources; a plain string is the one-source case.
 * With one source the attribution is implied, with several the provider has
 * to say which, and a snippet is checked against that source alone: a quote
 * that only exists across a boundary, or in another source, is not a quote.
 */
export function resolveProposal(
  product: ProductDocument,
  rawOutput: unknown,
  context: string | ContextBundle,
  provider: string,
): ProposalResult {
  const parsed = AgentOutputSchema.safeParse(rawOutput);
  if (!parsed.success) return { ok: false, issues: sorted(zodIssues("agent_output", parsed.error)) };
  const out = parsed.data;

  const issues: Issues = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });

  for (const key of ["personas", "needs", "steps", "assignments", "moves", "unresolvedQuestions"] as const) {
    if (out[key].length > MAX_ITEMS_PER_KIND)
      add("too_many_items", key, `at most ${MAX_ITEMS_PER_KIND} ${key} per proposal`);
  }
  if (issues.length > 0) return { ok: false, issues };

  const bundle = typeof context === "string" ? bundleFromTranscript(context) : context;
  const sources = new Map(bundle.sources.map((s) => [s.id, { label: s.label, haystack: normalizeSpace(s.text) }]));
  const text = (path: string, value: string, required = true): string => {
    const trimmed = value.trim();
    if (required && trimmed === "") add("empty_text", path, "must not be empty");
    if (trimmed.length > MAX_TEXT_LENGTH)
      add("text_too_long", path, `at most ${MAX_TEXT_LENGTH} characters`);
    return trimmed;
  };
  const source = (path: string, s: z.infer<typeof AgentSource>) => {
    const snippet = text(`${path}.snippet`, s.snippet);
    let sourceId = s.sourceId ?? undefined;
    if (sourceId === undefined) {
      if (bundle.sources.length === 1) sourceId = bundle.sources[0].id;
      else add("source_required", `${path}.sourceId`, "with several sources, say which one the snippet is quoted from");
    }
    const known = sourceId !== undefined ? sources.get(sourceId) : undefined;
    if (sourceId !== undefined && !known) add("unknown_source", `${path}.sourceId`, `"${sourceId}" is not a source of this context`);
    if (known && snippet !== "" && !known.haystack.includes(normalizeSpace(snippet)))
      add("snippet_not_in_source", `${path}.snippet`, `the quoted snippet does not occur in “${known.label}”`);
    if (!(s.confidence >= 0 && s.confidence <= 1))
      add("invalid_confidence", `${path}.confidence`, "confidence must be between 0 and 1");
    return {
      snippet,
      rationale: text(`${path}.rationale`, s.rationale, false),
      confidence: s.confidence,
      ...(known && sourceId !== undefined ? { sourceId, sourceLabel: known.label } : {}),
    };
  };

  const taken = allIds(product);
  const existing: Record<IdKind, Set<string>> = {
    persona: new Set(product.personas.map((e) => e.id)),
    need: new Set(product.needs.map((e) => e.id)),
    step: new Set(product.narrative.map((e) => e.id)),
    decision: new Set(product.decisions.map((e) => e.id)),
    wcbc: new Set(product.wcbc.map((e) => e.id)),
  };
  const refs: Record<"persona" | "need" | "step", Map<string, string>> = {
    persona: new Map(),
    need: new Map(),
    step: new Map(),
  };
  const declaredRefs = new Set<string>();

  const declare = (kind: "persona" | "need" | "step", path: string, ref: string, name: string): string => {
    if (!/^new:[a-z0-9][a-z0-9-]*$/.test(ref)) add("invalid_ref", path, `"${ref}" is not a valid new: ref`);
    else if (declaredRefs.has(ref)) add("duplicate_ref", path, `ref "${ref}" is declared twice`);
    declaredRefs.add(ref);
    const id = makeId(kind, name, taken);
    refs[kind].set(ref, id);
    return id;
  };
  const resolve = (kind: "persona" | "need" | "step", path: string, value: string): string => {
    if (value.startsWith("new:")) {
      const id = refs[kind].get(value);
      if (id) return id;
      add("unknown_ref", path, `"${value}" is not a ${kind} declared earlier in this proposal`);
      return value;
    }
    if (!existing[kind].has(value)) add("unknown_id", path, `${kind} "${value}" does not exist on the map`);
    return value;
  };
  const placement = (path: string, p: z.infer<typeof AgentPlacement>): Placement => {
    if (p.kind !== "after") {
      if (p.step !== null) add("invalid_placement", path, `placement "${p.kind}" must not name a step`);
      return { kind: p.kind };
    }
    if (p.step === null) {
      add("invalid_placement", path, `placement "after" must name a step`);
      return { kind: "end" };
    }
    return { kind: "after", stepId: resolve("step", `${path}.step`, p.step) };
  };

  const operations: PatchOperation[] = [];
  const nextOpId = () => `op-${operations.length + 1}`;
  // With alternatives, every goal is tagged as one of a choice; the alternatives come last so earlier ops keep their ids.
  const alternatives = out.goalAlternatives ?? [];
  const hasChoice = alternatives.length > 0;

  if (out.goal) {
    operations.push({
      opId: nextOpId(),
      op: "set_goal",
      statement: text("goal.statement", out.goal.statement),
      source: source("goal.source", out.goal.source),
      ...(hasChoice ? { choice: "goal" as const } : {}),
    });
  }

  out.personas.forEach((persona, i) => {
    const path = `personas[${i}]`;
    const name = text(`${path}.name`, persona.name);
    const roles: ValueChainRole[] = [];
    persona.roles.forEach((value, j) => {
      const role = ValueChainRoleSchema.safeParse(value);
      if (!role.success) add("unknown_role", `${path}.roles[${j}]`, `"${value}" is not a value-chain role`);
      else if (roles.includes(role.data)) add("duplicate_role", `${path}.roles[${j}]`, `role "${value}" is named twice`);
      else roles.push(role.data);
    });
    operations.push({
      opId: nextOpId(),
      op: "add_persona",
      id: declare("persona", `${path}.ref`, persona.ref, name),
      name,
      description: text(`${path}.description`, persona.description, false),
      ...(roles.length > 0 ? { roles } : {}),
      // The answer travels with the proposal, so the human sees it and it is never derived from a role.
      persona: persona.persona,
      source: source(`${path}.source`, persona.source),
    });
  });

  out.needs.forEach((need, i) => {
    const path = `needs[${i}]`;
    const statement = text(`${path}.statement`, need.statement);
    operations.push({
      opId: nextOpId(),
      op: "add_need",
      id: declare("need", `${path}.ref`, need.ref, statement),
      personaId: resolve("persona", `${path}.persona`, need.persona),
      statement,
      source: source(`${path}.source`, need.source),
    });
  });

  out.steps.forEach((step, i) => {
    const path = `steps[${i}]`;
    const title = text(`${path}.title`, step.title);
    // Placement is resolved before the step's own ref is declared, so a step
    // cannot be placed after itself.
    const resolvedPlacement = placement(`${path}.placement`, step.placement);
    operations.push({
      opId: nextOpId(),
      op: "add_step",
      id: declare("step", `${path}.ref`, step.ref, title),
      title,
      description: text(`${path}.description`, step.description, false),
      personaIds: step.personas.map((p, j) => resolve("persona", `${path}.personas[${j}]`, p)),
      needIds: step.needs.map((n, j) => resolve("need", `${path}.needs[${j}]`, n)),
      placement: resolvedPlacement,
      source: source(`${path}.source`, step.source),
    });
  });

  out.assignments.forEach((assignment, i) => {
    const path = `assignments[${i}]`;
    operations.push({
      opId: nextOpId(),
      op: "assign_persona",
      stepId: resolve("step", `${path}.step`, assignment.step),
      personaId: resolve("persona", `${path}.persona`, assignment.persona),
      source: source(`${path}.source`, assignment.source),
    });
  });

  out.moves.forEach((move, i) => {
    const path = `moves[${i}]`;
    operations.push({
      opId: nextOpId(),
      op: "move_step",
      stepId: resolve("step", `${path}.step`, move.step),
      placement: placement(`${path}.placement`, move.placement),
      source: source(`${path}.source`, move.source),
    });
  });

  out.unresolvedQuestions.forEach((item, i) => {
    const path = `unresolvedQuestions[${i}]`;
    const question = text(`${path}.question`, item.question);
    const relatesTo = item.relatesTo.map((value, j) => {
      if (value.startsWith("new:")) {
        const id = refs.persona.get(value) ?? refs.need.get(value) ?? refs.step.get(value);
        if (!id) add("unknown_ref", `${path}.relatesTo[${j}]`, `"${value}" is not declared in this proposal`);
        return id ?? value;
      }
      if (!allIds(product).has(value))
        add("unknown_id", `${path}.relatesTo[${j}]`, `"${value}" does not exist on the map`);
      return value;
    });
    operations.push({
      opId: nextOpId(),
      op: "add_question",
      id: makeId("decision", question, taken),
      question,
      relatesTo,
      source: source(`${path}.source`, item.source),
    });
  });

  alternatives.forEach((alternative, i) => {
    const path = `goalAlternatives[${i}]`;
    if (!out.goal) add("alternative_without_goal", path, "an alternative goal needs a goal to be an alternative to");
    operations.push({
      opId: nextOpId(),
      op: "set_goal",
      statement: text(`${path}.statement`, alternative.statement),
      source: source(`${path}.source`, alternative.source),
      choice: "goal",
    });
  });

  if (operations.length === 0)
    add("empty_proposal", "(root)", "the discussion did not yield any proposed change or question");
  if (issues.length > 0) return { ok: false, issues: sorted(issues) };

  const patch: MapPatch = {
    patchVersion: 1,
    provider,
    baseFingerprint: fingerprint(product),
    baseRevision: product.revision.number,
    summary: out.summary.trim().slice(0, MAX_TEXT_LENGTH),
    operations,
  };

  // Dry run: a proposal that could not be accepted as it stands is not shown as one.
  // With a goal choice, each option is tried on its own; the patch with all of them is not acceptable by design.
  const goals = operations.filter((o) => o.op === "set_goal");
  const variants = goals.length > 1 ? goals.map((keep) => ({ ...patch, operations: operations.filter((o) => o.op !== "set_goal" || o.opId === keep.opId) })) : [patch];
  for (const variant of variants) {
    const dryRun = applyMapPatch(product, variant);
    if (!dryRun.ok) return { ok: false, issues: dryRun.issues, stage: "apply" };
  }
  return { ok: true, patch };
}

// ------------------------------------------------------------------ apply patch

export type Touch = "added" | "changed" | "moved";

export type ApplyResult =
  | { ok: true; product: ProductDocument; touched: Record<string, Touch> }
  | { ok: false; issues: Issues };

function place(order: string[], stepId: string, placement: Placement): string[] | null {
  const rest = order.filter((id) => id !== stepId);
  if (placement.kind === "start") return [stepId, ...rest];
  if (placement.kind === "end") return [...rest, stepId];
  const index = rest.indexOf(placement.stepId);
  if (index === -1) return null;
  return [...rest.slice(0, index + 1), stepId, ...rest.slice(index + 1)];
}

/**
 * Apply an accepted patch to the map it was built against.
 *
 * - Refuses a patch built against a different state of the map.
 * - Touches only what its operations name.
 * - Always yields the next *proposed* revision; approval stays a separate,
 *   explicit human action.
 * - Records the source snippet and rationale of every operation as provenance.
 * - Pure: returns the new document, writes nothing.
 */
export function applyMapPatch(product: ProductDocument, patchInput: unknown): ApplyResult {
  const parsed = MapPatchSchema.safeParse(patchInput);
  if (!parsed.success) return { ok: false, issues: sorted(zodIssues("patch", parsed.error)) };
  const patch = parsed.data;

  if (patch.baseFingerprint !== fingerprint(product)) {
    return {
      ok: false,
      issues: [
        {
          code: "stale_patch",
          path: "baseFingerprint",
          message: "the map has changed since this proposal was made; structure the discussion again",
        },
      ],
    };
  }
  if (patch.operations.length === 0)
    return { ok: false, issues: [{ code: "empty_patch", path: "operations", message: "nothing to accept" }] };
  // Two goals are a choice the human has not made yet. Nothing here picks one.
  if (patch.operations.filter((o) => o.op === "set_goal").length > 1)
    return {
      ok: false,
      issues: [{ code: "conflicting_goal", path: "operations", message: "the proposal offers more than one goal; keep exactly one" }],
    };

  const issues: Issues = [];
  const revision = product.revision.number + 1;
  const ids = allIds(product);
  const opIds = new Set<string>();
  const touched: Record<string, Touch> = {};
  const provenance: Provenance[] = [...product.provenance];

  let goal = product.goal;
  const personas = [...product.personas];
  const needs = [...product.needs];
  const decisions = [...product.decisions];
  const wcbc = [...product.wcbc];
  const steps = new Map(product.narrative.map((s) => [s.id, { ...s, personaIds: [...s.personaIds] }]));
  let order = [...product.narrative].sort((a, b) => a.sequence - b.sequence).map((s) => s.id);

  patch.operations.forEach((operation, i) => {
    const path = `operations[${i}]`;
    const add = (code: string, field: string, message: string) =>
      issues.push({ code, path: `${path}.${field}`, message });
    const failuresBefore = issues.length;

    if (opIds.has(operation.opId)) add("duplicate_op", "opId", `"${operation.opId}" is used twice`);
    opIds.add(operation.opId);

    const fresh = (kind: IdKind, id: string) => {
      if (!hasPrefix(kind, id))
        add("id_convention", "id", `a new ${kind} id must start with "${ID_PREFIX[kind]}-"`);
      if (ids.has(id)) add("duplicate_id", "id", `"${id}" already exists`);
    };
    const known = (set: Iterable<{ id: string }> | Map<string, unknown>, field: string, id: string, what: string) => {
      const found = set instanceof Map ? set.has(id) : [...set].some((e) => e.id === id);
      if (!found) add("unknown_id", field, `${what} "${id}" does not exist`);
      return found;
    };
    const placeStep = (stepId: string, placement: Placement) => {
      if (placement.kind === "after" && placement.stepId === stepId) {
        add("invalid_placement", "placement", "a step cannot be placed after itself");
        return;
      }
      const next = place(order, stepId, placement);
      if (!next) add("unknown_id", "placement.stepId", `step "${(placement as { stepId: string }).stepId}" does not exist`);
      else order = next;
    };
    const record = (targetId: string, change: Provenance["change"], touch: Touch) => {
      if (issues.length > failuresBefore) return;
      provenance.push({ targetId, change, ...operation.source, provider: patch.provider, revision });
      touched[targetId] = touched[targetId] === "added" ? "added" : touch;
    };

    switch (operation.op) {
      case "set_goal":
        goal = { ...goal, statement: operation.statement };
        record(goal.id, "changed", "changed");
        break;
      case "add_persona":
        fresh("persona", operation.id);
        if (issues.length === failuresBefore) {
          personas.push({
            id: operation.id,
            name: operation.name,
            description: operation.description,
            ...(operation.roles && operation.roles.length > 0 ? { roles: [...operation.roles] } : {}),
            // Written only where the answer is "no": a persona stays the plain entry it always was.
            ...(operation.persona === false ? { persona: false } : {}),
          });
          ids.add(operation.id);
        }
        record(operation.id, "added", "added");
        break;
      case "add_need":
        fresh("need", operation.id);
        known(personas, "personaId", operation.personaId, "persona");
        if (issues.length === failuresBefore) {
          needs.push({ id: operation.id, personaId: operation.personaId, statement: operation.statement });
          ids.add(operation.id);
        }
        record(operation.id, "added", "added");
        break;
      case "add_step":
        fresh("step", operation.id);
        operation.personaIds.forEach((id, j) => known(personas, `personaIds[${j}]`, id, "persona"));
        operation.needIds.forEach((id, j) => known(needs, `needIds[${j}]`, id, "need"));
        if (issues.length === failuresBefore) {
          steps.set(operation.id, {
            id: operation.id,
            sequence: 0,
            title: operation.title,
            description: operation.description,
            personaIds: [...operation.personaIds],
            needIds: [...operation.needIds],
          });
          ids.add(operation.id);
          placeStep(operation.id, operation.placement);
        }
        record(operation.id, "added", "added");
        break;
      case "assign_persona": {
        const stepKnown = known(steps, "stepId", operation.stepId, "step");
        const personaKnown = known(personas, "personaId", operation.personaId, "persona");
        const step = steps.get(operation.stepId);
        if (stepKnown && personaKnown && step) {
          if (step.personaIds.includes(operation.personaId))
            add("already_assigned", "personaId", "this persona is already assigned to the step");
          else step.personaIds.push(operation.personaId);
        }
        record(operation.stepId, "assigned", "changed");
        break;
      }
      case "move_step":
        if (known(steps, "stepId", operation.stepId, "step")) placeStep(operation.stepId, operation.placement);
        record(operation.stepId, "moved", "moved");
        break;
      case "add_question":
        fresh("decision", operation.id);
        operation.relatesTo.forEach((id, j) => {
          if (!ids.has(id)) add("unknown_id", `relatesTo[${j}]`, `"${id}" does not exist`);
        });
        if (issues.length === failuresBefore) {
          // An unresolved question is always an *open* decision. Nothing an
          // agent proposes can arrive as decided.
          decisions.push({
            id: operation.id,
            title: operation.question,
            status: "open",
            rationale: "",
            relatesTo: [...operation.relatesTo],
          });
          ids.add(operation.id);
        }
        record(operation.id, "added", "added");
        break;
      case "add_wcbc": {
        fresh("wcbc", operation.id);
        known(steps, "stepId", operation.stepId, "step");
        const outcome = operation.outcome;
        if (outcome?.kind === "recovery") known(steps, "outcome.resumeStepId", outcome.resumeStepId, "step");
        if (outcome?.kind === "escalation") known(personas, "outcome.toPersonaId", outcome.toPersonaId, "persona");
        if (issues.length === failuresBefore) {
          wcbc.push({
            id: operation.id,
            stepId: operation.stepId,
            kind: operation.kind,
            title: operation.title,
            description: operation.description,
            recovery: operation.recovery,
            ...(outcome ? { outcome } : {}),
          });
          ids.add(operation.id);
        }
        record(operation.id, "added", "added");
        break;
      }
    }
  });

  if (issues.length > 0) return { ok: false, issues: sorted(issues) };

  const next: ProductDocument = {
    ...product,
    revision: { number: revision, status: "proposed" },
    goal,
    personas,
    needs,
    narrative: order.map((id, index) => ({ ...steps.get(id)!, sequence: index + 1 })),
    wcbc,
    decisions,
    provenance,
  };

  const validated = validateProduct(next);
  if (!validated.ok) return { ok: false, issues: validated.issues };
  return { ok: true, product: validated.product, touched };
}

// ------------------------------------------------------------ human-readable diff

export interface DiffEntry {
  opId: string;
  op: PatchOperation["op"];
  targetId: string;
  headline: string;
  before?: string;
  after?: string;
  source: MapPatch["operations"][number]["source"];
}

function describeOutcome(
  outcome: z.infer<typeof WcbcOutcomeSchema> | undefined,
  step: (id: string) => string,
  persona: (id: string) => string,
): string {
  if (!outcome) return "";
  if (outcome.kind === "recovery") return `Leads back to step ${step(outcome.resumeStepId)}.`;
  if (outcome.kind === "escalation") return `Escalates to ${persona(outcome.toPersonaId)}.`;
  return "The path ends here.";
}

/** One plain-language line per operation, for the human who has to decide. */
export function describePatch(product: ProductDocument, patch: MapPatch): DiffEntry[] {
  const personaName = new Map(product.personas.map((e) => [e.id, e.name]));
  const stepTitle = new Map(product.narrative.map((e) => [e.id, e.title]));
  for (const operation of patch.operations) {
    if (operation.op === "add_persona") personaName.set(operation.id, operation.name);
    if (operation.op === "add_step") stepTitle.set(operation.id, operation.title);
  }
  const persona = (id: string) => `“${personaName.get(id) ?? id}”`;
  const step = (id: string) => `“${stepTitle.get(id) ?? id}”`;
  const where = (placement: Placement) =>
    placement.kind === "after" ? `after ${step(placement.stepId)}` : `at the ${placement.kind}`;

  return patch.operations.map((operation) => {
    const base = { opId: operation.opId, op: operation.op, source: operation.source };
    switch (operation.op) {
      case "set_goal":
        // A first product has no goal yet: there is nothing it changes from.
        return product.goal.statement === ""
          ? { ...base, targetId: product.goal.id, headline: "Say what the product is for", after: operation.statement }
          : {
              ...base,
              targetId: product.goal.id,
              headline: "Change the product goal",
              before: product.goal.statement,
              after: operation.statement,
            };
      case "add_persona":
        return {
          ...base,
          targetId: operation.id,
          headline:
            operation.persona === false
              ? `Add ${persona(operation.id)}: involved, not a persona (their needs are not modelled)`
              : `Add persona ${persona(operation.id)}`,
          after: [
            operation.description,
            operation.roles && operation.roles.length > 0 ? `Role: ${operation.roles.map((role) => ROLE_LABEL[role]).join(", ")}.` : "",
          ]
            .filter(Boolean)
            .join(" "),
        };
      case "add_need":
        return {
          ...base,
          targetId: operation.id,
          headline: `Add a need for ${persona(operation.personaId)}`,
          after: operation.statement,
        };
      case "add_step":
        return {
          ...base,
          targetId: operation.id,
          headline:
            `Add step ${step(operation.id)} ${where(operation.placement)}` +
            (operation.personaIds.length > 0 ? `, for ${operation.personaIds.map(persona).join(", ")}` : ""),
          after: [operation.description, operation.needIds.length > 0 ? `Serves ${operation.needIds.length} need(s).` : ""].filter(Boolean).join(" "),
        };
      case "assign_persona":
        return {
          ...base,
          targetId: operation.stepId,
          headline: `Assign ${persona(operation.personaId)} to step ${step(operation.stepId)}`,
        };
      case "move_step":
        return {
          ...base,
          targetId: operation.stepId,
          headline: `Move step ${step(operation.stepId)} ${where(operation.placement)}`,
        };
      case "add_question":
        return {
          ...base,
          targetId: operation.id,
          headline: "Unresolved question (becomes an open decision)",
          after: operation.question,
        };
      case "add_wcbc":
        return {
          ...base,
          targetId: operation.id,
          headline: `Add ${operation.kind === "worst_case" ? "worst case" : "best case"} “${operation.title}” to step ${step(operation.stepId)}`,
          after: [operation.description, operation.recovery && `Recovery: ${operation.recovery}`, describeOutcome(operation.outcome, step, persona)]
            .filter(Boolean)
            .join(" "),
        };
    }
  });
}
