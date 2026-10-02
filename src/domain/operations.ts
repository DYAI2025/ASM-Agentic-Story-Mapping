import { MAX_LAYOUT_ROW, type ProductDocument, type WcbcOutcome } from "./schema";
import { validateProduct } from "./validate";

export class DomainError extends Error {}

export type CardKind = "goal" | "persona" | "need" | "step" | "wcbc" | "decision";

/** Text fields a human may edit per card kind. Ids and relations are never editable here. */
export const EDITABLE_FIELDS: Record<CardKind, readonly string[]> = {
  goal: ["statement"],
  persona: ["name", "description"],
  need: ["statement"],
  step: ["title", "description"],
  wcbc: ["title", "description", "recovery"],
  decision: ["title", "rationale"],
};

type Semantics = Omit<ProductDocument, "layout">;

/** The meaning of a product document: everything except visual layout. */
export function semanticsOf(p: ProductDocument): Semantics {
  const { layout: _layout, ...semantics } = p;
  return semantics;
}

export function kindOf(p: ProductDocument, id: string): CardKind | undefined {
  if (p.goal.id === id) return "goal";
  if (p.personas.some((e) => e.id === id)) return "persona";
  if (p.needs.some((e) => e.id === id)) return "need";
  if (p.narrative.some((e) => e.id === id)) return "step";
  if (p.wcbc.some((e) => e.id === id)) return "wcbc";
  if (p.decisions.some((e) => e.id === id)) return "decision";
  return undefined;
}

/**
 * A semantic change to an approved revision opens a new proposed revision.
 * Approval never survives a change of meaning.
 */
function reopenIfApproved(p: ProductDocument): ProductDocument["revision"] {
  if (p.revision.status === "proposed") return p.revision;
  return { number: p.revision.number + 1, status: "proposed" };
}

function assertValid(p: ProductDocument): ProductDocument {
  const result = validateProduct(p);
  if (!result.ok)
    throw new DomainError(
      `operation would produce an invalid product: ${result.issues
        .map((i) => `${i.path}: ${i.message}`)
        .join("; ")}`,
    );
  return result.product;
}

export function updateCard(
  p: ProductDocument,
  id: string,
  patch: Record<string, string>,
): ProductDocument {
  const kind = kindOf(p, id);
  if (!kind) throw new DomainError(`no card with id "${id}"`);
  for (const key of Object.keys(patch)) {
    if (!EDITABLE_FIELDS[kind].includes(key))
      throw new DomainError(`field "${key}" is not editable on a ${kind} card`);
  }
  const apply = <T extends { id: string }>(e: T): T => (e.id === id ? { ...e, ...patch } : e);
  return assertValid({
    ...p,
    revision: reopenIfApproved(p),
    goal: apply(p.goal),
    personas: p.personas.map(apply),
    needs: p.needs.map(apply),
    narrative: p.narrative.map(apply),
    wcbc: p.wcbc.map(apply),
    decisions: p.decisions.map(apply),
  });
}

/** Semantic reorder: swaps the step with its neighbour in the main narrative. */
export function moveStep(p: ProductDocument, stepId: string, direction: -1 | 1): ProductDocument {
  const step = p.narrative.find((s) => s.id === stepId);
  if (!step) throw new DomainError(`no narrative step with id "${stepId}"`);
  const neighbour = p.narrative.find((s) => s.sequence === step.sequence + direction);
  if (!neighbour) throw new DomainError(`step "${stepId}" cannot move further in that direction`);
  return assertValid({
    ...p,
    revision: reopenIfApproved(p),
    narrative: p.narrative.map((s) => {
      if (s.id === step.id) return { ...s, sequence: neighbour.sequence };
      if (s.id === neighbour.id) return { ...s, sequence: step.sequence };
      return s;
    }),
  });
}

/** Says where a WCBC branch leads. A semantic change; `null` removes the outcome. */
export function setWcbcOutcome(p: ProductDocument, wcbcId: string, outcome: WcbcOutcome | null): ProductDocument {
  if (!p.wcbc.some((b) => b.id === wcbcId)) throw new DomainError(`no WCBC branch with id "${wcbcId}"`);
  return assertValid({
    ...p,
    revision: reopenIfApproved(p),
    wcbc: p.wcbc.map((b) => {
      if (b.id !== wcbcId) return b;
      const { outcome: _outcome, ...rest } = b;
      return outcome ? { ...rest, outcome } : rest;
    }),
  });
}

/**
 * Visual-only change. Touches `layout` and nothing else, so it neither
 * alters meaning nor reopens an approved revision.
 */
export function setCardRow(p: ProductDocument, id: string, row: number): ProductDocument {
  if (!kindOf(p, id)) throw new DomainError(`no card with id "${id}"`);
  if (!Number.isInteger(row) || row < 0 || row > MAX_LAYOUT_ROW)
    throw new DomainError(`row must be an integer between 0 and ${MAX_LAYOUT_ROW}`);
  const cards = { ...p.layout.cards };
  if (row === 0) delete cards[id];
  else cards[id] = { row };
  return assertValid({ ...p, layout: { cards } });
}

/** The only way a revision becomes approved. */
export function approveRevision(
  p: ProductDocument,
  approval: { approvedBy: string; approvedAt: string },
): ProductDocument {
  if (p.revision.status === "approved")
    throw new DomainError(`revision ${p.revision.number} is already approved`);
  if (approval.approvedBy.trim() === "")
    throw new DomainError("approval requires the name of the approving human");
  return assertValid({
    ...p,
    revision: {
      number: p.revision.number,
      status: "approved",
      approval: { approvedBy: approval.approvedBy.trim(), approvedAt: approval.approvedAt },
    },
  });
}
