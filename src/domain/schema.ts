import { z } from "zod";

/**
 * Canonical ASM product schema (v1).
 *
 * Everything except `layout` is semantic. `layout` only stores visual hints;
 * meaning (order, ownership, relations) is always carried by explicit fields
 * such as `sequence`, `personaId`, `stepId` and `relatesTo`.
 */

export const SCHEMA_VERSION = 1 as const;

export const IdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "id must be lowercase kebab-case starting with a letter");

const Text = z.string().trim().min(1, "must not be empty");

export const RevisionStatusSchema = z.enum(["proposed", "approved"]);

export const ApprovalSchema = z.strictObject({
  approvedBy: Text,
  approvedAt: z.iso.datetime(),
});

export const RevisionSchema = z.strictObject({
  number: z.number().int().min(1),
  status: RevisionStatusSchema,
  approval: ApprovalSchema.optional(),
});

export const ProductInfoSchema = z.strictObject({
  id: IdSchema,
  name: Text,
  summary: Text,
});

export const GoalSchema = z.strictObject({
  id: IdSchema,
  statement: Text,
});

export const PersonaSchema = z.strictObject({
  id: IdSchema,
  name: Text,
  description: z.string(),
});

export const NeedSchema = z.strictObject({
  id: IdSchema,
  personaId: IdSchema,
  statement: Text,
});

export const NarrativeStepSchema = z.strictObject({
  id: IdSchema,
  /** Semantic position in the main narrative (1..n). Not a pixel position. */
  sequence: z.number().int().min(1),
  title: Text,
  description: z.string(),
  personaIds: z.array(IdSchema),
  needIds: z.array(IdSchema),
});

export const WcbcKindSchema = z.enum(["worst_case", "best_case"]);

/**
 * Where a branch leads. `recovery` free text says how; the outcome says where
 * to, as a reference the map can check:
 *   recovery     back onto the main path at `resumeStepId`
 *   termination  the path ends here
 *   escalation   a named persona takes over
 */
export const WcbcOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("recovery"), resumeStepId: IdSchema }),
  z.strictObject({ kind: z.literal("termination") }),
  z.strictObject({ kind: z.literal("escalation"), toPersonaId: IdSchema }),
]);

export const WcbcSchema = z.strictObject({
  id: IdSchema,
  stepId: IdSchema,
  kind: WcbcKindSchema,
  title: Text,
  description: z.string(),
  recovery: z.string(),
  outcome: WcbcOutcomeSchema.optional(),
});

export const DecisionStatusSchema = z.enum(["open", "decided"]);

export const DecisionSchema = z.strictObject({
  id: IdSchema,
  title: Text,
  status: DecisionStatusSchema,
  rationale: z.string(),
  relatesTo: z.array(IdSchema),
});

export const MAX_LAYOUT_ROW = 2;

export const LayoutSchema = z.strictObject({
  cards: z.record(
    IdSchema,
    z.strictObject({ row: z.number().int().min(0).max(MAX_LAYOUT_ROW) }),
  ),
});

/**
 * Where an accepted change came from. Written only when a human accepts a
 * proposal; `confidence` is advisory metadata and never drives behaviour.
 */
export const ProvenanceSchema = z.strictObject({
  targetId: IdSchema,
  change: z.enum(["added", "changed", "assigned", "moved"]),
  snippet: Text,
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  provider: Text,
  revision: z.number().int().min(1),
});

export const ProductDocumentSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  product: ProductInfoSchema,
  revision: RevisionSchema,
  goal: GoalSchema,
  personas: z.array(PersonaSchema),
  needs: z.array(NeedSchema),
  narrative: z.array(NarrativeStepSchema),
  wcbc: z.array(WcbcSchema),
  decisions: z.array(DecisionSchema),
  provenance: z.array(ProvenanceSchema).default([]),
  layout: LayoutSchema,
});

export type RevisionStatus = z.infer<typeof RevisionStatusSchema>;
export type Persona = z.infer<typeof PersonaSchema>;
export type Need = z.infer<typeof NeedSchema>;
export type NarrativeStep = z.infer<typeof NarrativeStepSchema>;
export type Wcbc = z.infer<typeof WcbcSchema>;
export type WcbcOutcome = z.infer<typeof WcbcOutcomeSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type ProductDocument = z.infer<typeof ProductDocumentSchema>;
