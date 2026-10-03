import { z } from "zod";
import { fingerprint } from "./fingerprint";
import { DomainError } from "./operations";
import { IdSchema, type ProductDocument } from "./schema";
import {
  SLICE_DERIVATION_VERSION,
  candidateFingerprint,
  checkSliceCandidate,
  proposeSlices,
  type SliceCandidate,
} from "./slices";
import type { ValidationIssue } from "./validate";

/**
 * Work state: what a human decided to work on. Not product canon.
 *
 * The product document says what the product means. Which slice of it someone
 * picked to build next is delivery state: it lives in its own file and
 * selecting never changes the product document.
 *
 * Before a slice can be selected, a named human confirms that they considered
 * who else is relevant for the goal (the people check). That, too, is work
 * state: it says what a human did, not what the product means.
 *
 * A selection stores no copy of the slice. It names a candidate and binds
 * itself to the exact map revision, the map fingerprint, the fingerprint of
 * the candidate and the version of the derivation rules. If any of them no
 * longer matches, the selection is stale and nothing can be exported from it.
 */

export const WORK_STATE_VERSION = 1 as const;

const Text = z.string().trim().min(1, "must not be empty");
const Fingerprint = z.string().regex(/^[0-9a-f]{8}$/);

/**
 * A human's authorization to build a slice that references no need. It is a
 * decision under uncertainty, not evidence that the slice has business value.
 */
export const ValueExceptionSchema = z.strictObject({
  rationale: Text,
  acceptedBy: Text,
  acceptedAt: z.iso.datetime(),
});

/**
 * A named human says they considered who else is relevant for this goal,
 * beyond the people on the map. It is a statement about what the human did.
 * It is not a statement that the people on the map are complete, and nothing
 * but a human can make it. Bound to the exact map it was made on: after any
 * change of meaning it is stale.
 */
export const PersonaCheckSchema = z.strictObject({
  productId: IdSchema,
  revision: z.number().int().min(1),
  mapFingerprint: Fingerprint,
  confirmedBy: Text,
  confirmedAt: z.iso.datetime(),
});

export const SliceSelectionSchema = z.strictObject({
  candidateId: IdSchema,
  productId: IdSchema,
  revision: z.number().int().min(1),
  mapFingerprint: Fingerprint,
  candidateFingerprint: Fingerprint,
  derivationVersion: z.number().int().min(1),
  selectedBy: Text,
  selectedAt: z.iso.datetime(),
  /**
   * The people check the slice was selected under. Optional only so that a
   * work-state file from before this gate still loads; a selection without it
   * is stale.
   */
  personaCheck: z.strictObject({ confirmedBy: Text, confirmedAt: z.iso.datetime() }).optional(),
  valueException: ValueExceptionSchema.optional(),
});

export const WorkStateSchema = z.strictObject({
  workStateVersion: z.literal(WORK_STATE_VERSION),
  personaCheck: PersonaCheckSchema.optional(),
  selection: SliceSelectionSchema.optional(),
});

export type ValueException = z.infer<typeof ValueExceptionSchema>;
export type PersonaCheck = z.infer<typeof PersonaCheckSchema>;
export type SliceSelection = z.infer<typeof SliceSelectionSchema>;
export type WorkState = z.infer<typeof WorkStateSchema>;

export type WorkStateResult = { ok: true; state: WorkState } | { ok: false; issues: ValidationIssue[] };

export const EMPTY_WORK_STATE: WorkState = { workStateVersion: WORK_STATE_VERSION };

export function validateWorkState(input: unknown): WorkStateResult {
  const parsed = WorkStateSchema.safeParse(input);
  if (parsed.success) return { ok: true, state: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      code: `schema_${issue.code}`,
      path: issue.path.map(String).join(".") || "(root)",
      message: issue.message,
    })),
  };
}

export function exportWorkStateJson(state: WorkState): string {
  const s = state.selection;
  const c = state.personaCheck;
  const ordered: WorkState = {
    workStateVersion: state.workStateVersion,
    ...(c
      ? {
          personaCheck: {
            productId: c.productId,
            revision: c.revision,
            mapFingerprint: c.mapFingerprint,
            confirmedBy: c.confirmedBy,
            confirmedAt: c.confirmedAt,
          },
        }
      : {}),
    ...(s
      ? {
          selection: {
            candidateId: s.candidateId,
            productId: s.productId,
            revision: s.revision,
            mapFingerprint: s.mapFingerprint,
            candidateFingerprint: s.candidateFingerprint,
            derivationVersion: s.derivationVersion,
            selectedBy: s.selectedBy,
            selectedAt: s.selectedAt,
            ...(s.personaCheck ? { personaCheck: { confirmedBy: s.personaCheck.confirmedBy, confirmedAt: s.personaCheck.confirmedAt } } : {}),
            ...(s.valueException
              ? {
                  valueException: {
                    rationale: s.valueException.rationale,
                    acceptedBy: s.valueException.acceptedBy,
                    acceptedAt: s.valueException.acceptedAt,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export type PersonaCheckResolution = { ok: true } | { ok: false; issues: ValidationIssue[] };

/**
 * Whether the people check stands for the map as it is now. Never made and
 * made on an earlier map are different answers, and both mean: not now.
 */
export function resolvePersonaCheck(p: ProductDocument, check: PersonaCheck | null | undefined): PersonaCheckResolution {
  if (!check)
    return {
      ok: false,
      issues: [
        {
          code: "persona_check_required",
          path: "personaCheck",
          message: "nobody has confirmed yet that they considered who else is relevant for this goal",
        },
      ],
    };
  const stale = (message: string): PersonaCheckResolution => ({ ok: false, issues: [{ code: "stale_persona_check", path: "personaCheck", message }] });
  if (check.productId !== p.product.id)
    return stale(`the confirmation by ${check.confirmedBy} was made for another product ("${check.productId}"); it has to be made again for this one`);
  if (check.revision !== p.revision.number || check.mapFingerprint !== fingerprint(p))
    return stale(`the confirmation by ${check.confirmedBy} was made on an earlier map; the map has changed since, so it has to be made again`);
  return { ok: true };
}

/**
 * The human gate before slicing. The only way a people check comes to exist.
 *
 * - Needs a named human, like approval and selection do.
 * - Only on an approved revision: what is confirmed is the approved narrative.
 * - `mapFingerprint` is the fingerprint of the map the human was looking at.
 *
 * The product document is read, never changed.
 */
export function confirmPersonaCheck(
  p: ProductDocument,
  confirmation: { confirmedBy: string; confirmedAt: string; mapFingerprint: string },
): PersonaCheck {
  if (confirmation.confirmedBy.trim() === "") throw new DomainError("confirming requires the name of the human who confirms");
  if (p.revision.status !== "approved")
    throw new DomainError(`revision ${p.revision.number} is not approved; who else is relevant is confirmed for an approved narrative`);
  if (confirmation.mapFingerprint !== fingerprint(p)) throw new DomainError("the map has changed since you looked at it; look at the people again");
  return {
    productId: p.product.id,
    revision: p.revision.number,
    mapFingerprint: fingerprint(p),
    confirmedBy: confirmation.confirmedBy.trim(),
    confirmedAt: confirmation.confirmedAt,
  };
}

export type SelectionResolution = { ok: true; candidate: SliceCandidate } | { ok: false; issues: ValidationIssue[] };

const stale = (path: string, message: string): SelectionResolution => ({
  ok: false,
  issues: [{ code: "stale_selection", path, message: `${message}; select a slice again` }],
});

/**
 * The candidate a selection stands for, or the reason the selection is stale.
 * Stale means: another product, another revision or map fingerprint, another
 * version of the derivation rules, or a candidate that is no longer the one
 * that was selected.
 */
export function resolveSelection(p: ProductDocument, selection: SliceSelection): SelectionResolution {
  if (selection.productId !== p.product.id)
    return stale("selection.productId", `the slice was selected on product "${selection.productId}", not "${p.product.id}"`);
  if (selection.revision !== p.revision.number || selection.mapFingerprint !== fingerprint(p))
    return stale("selection.mapFingerprint", "the map has changed since the slice was selected");
  if (!selection.personaCheck)
    return stale("selection.personaCheck", "the slice was selected without a confirmation that someone considered who else is relevant");
  if (selection.derivationVersion !== SLICE_DERIVATION_VERSION)
    return stale(
      "selection.derivationVersion",
      `the slice was selected under derivation rules version ${selection.derivationVersion}; the rules are now version ${SLICE_DERIVATION_VERSION}`,
    );
  const proposal = proposeSlices(p);
  const candidate = proposal.ok ? proposal.candidates.find((c) => c.id === selection.candidateId) : undefined;
  if (!candidate || candidateFingerprint(candidate) !== selection.candidateFingerprint)
    return stale("selection.candidateFingerprint", "the selected slice is no longer the candidate that was selected");
  return { ok: true, candidate };
}

/**
 * Whether the map gives a reason for the slice. A label, never a number:
 *   VALUE_RESOLVED            at least one included step references a need on the map
 *   VALUE_UNRESOLVED          no need is referenced; the slice cannot be exported
 *   VALUE_EXCEPTION_ACCEPTED  no need is referenced, and a named human accepted that in writing
 */
export type ValueStatus = "VALUE_RESOLVED" | "VALUE_UNRESOLVED" | "VALUE_EXCEPTION_ACCEPTED";

export function valueStatus(
  p: ProductDocument,
  candidate: Pick<SliceCandidate, "id" | "needIds">,
  selection?: SliceSelection | null,
): ValueStatus {
  const known = new Set(p.needs.map((n) => n.id));
  if (candidate.needIds.some((id) => known.has(id))) return "VALUE_RESOLVED";
  return selection?.candidateId === candidate.id && selection.valueException ? "VALUE_EXCEPTION_ACCEPTED" : "VALUE_UNRESOLVED";
}

/**
 * The human gate. The only way a slice becomes the selected one.
 *
 * - Needs a named human, like approval does.
 * - Only on an approved revision.
 * - `mapFingerprint` is the fingerprint of the map the human was looking at;
 *   if the map has changed since, the selection is refused.
 * - Only under a current people check (`confirmPersonaCheck`): a human has
 *   confirmed, for this exact map, that they considered who else is relevant.
 * - The candidate is looked up among the candidates of the map as it is now,
 *   so nothing that is not derived from the map can be selected.
 *
 * Returns the selection. The product document is read, never changed. A new
 * selection carries no value exception: that is a separate human action.
 */
export function selectSlice(
  p: ProductDocument,
  choice: { candidateId: string; selectedBy: string; selectedAt: string; mapFingerprint: string; personaCheck: PersonaCheck | null | undefined },
): SliceSelection {
  if (choice.selectedBy.trim() === "") throw new DomainError("selecting a slice requires the name of the human who selects it");
  if (p.revision.status !== "approved")
    throw new DomainError(`revision ${p.revision.number} is not approved; a slice can only be selected on an approved narrative`);
  const people = resolvePersonaCheck(p, choice.personaCheck);
  if (!people.ok || !choice.personaCheck)
    throw new DomainError(
      `a slice can only be selected once a human has confirmed that they considered who else is relevant: ${people.ok ? "no confirmation" : people.issues[0].message}`,
    );
  if (choice.mapFingerprint !== fingerprint(p))
    throw new DomainError("the map has changed since these candidates were shown; review the candidates again");

  const proposal = proposeSlices(p);
  if (!proposal.ok) throw new DomainError(proposal.issues.map((i) => i.message).join("; "));
  const candidate = proposal.candidates.find((c) => c.id === choice.candidateId);
  if (!candidate) throw new DomainError(`"${choice.candidateId}" is not a slice candidate of this map`);
  const check = checkSliceCandidate(p, candidate);
  if (check.issues.length > 0) throw new DomainError(check.issues.map((i) => i.message).join("; "));

  return {
    candidateId: candidate.id,
    productId: p.product.id,
    revision: p.revision.number,
    mapFingerprint: fingerprint(p),
    candidateFingerprint: candidateFingerprint(candidate),
    derivationVersion: SLICE_DERIVATION_VERSION,
    selectedBy: choice.selectedBy.trim(),
    selectedAt: choice.selectedAt,
    personaCheck: { confirmedBy: choice.personaCheck.confirmedBy, confirmedAt: choice.personaCheck.confirmedAt },
  };
}

/**
 * A named human accepts, with a written rationale, that the selected slice
 * references no need. Only for a current selection whose value is unresolved.
 */
export function acceptValueException(
  p: ProductDocument,
  selection: SliceSelection,
  exception: { rationale: string; acceptedBy: string; acceptedAt: string },
): SliceSelection {
  if (exception.acceptedBy.trim() === "") throw new DomainError("a value exception requires the name of the human who accepts it");
  if (exception.rationale.trim() === "")
    throw new DomainError("a value exception requires a rationale: say why this slice should be built although it references no need");
  const resolved = resolveSelection(p, selection);
  if (!resolved.ok) throw new DomainError(resolved.issues.map((i) => i.message).join("; "));
  if (valueStatus(p, resolved.candidate) === "VALUE_RESOLVED")
    throw new DomainError("the selected slice references a need; it needs no value exception");
  return {
    ...selection,
    valueException: {
      rationale: exception.rationale.trim(),
      acceptedBy: exception.acceptedBy.trim(),
      acceptedAt: exception.acceptedAt,
    },
  };
}
