import { ROLE_LABEL } from "./actors";
import { EDITABLE_OP_FIELDS, describePatch, type DiffEntry, type MapPatch, type PatchOperation } from "./map-patch";
import type { ProductDocument } from "./schema";

/**
 * The proposal as product meaning, for the human who reviews it: not a list
 * of patch operations but the goal, the people, their needs, the path and the
 * open questions. A pure projection over `describePatch`; the patch itself,
 * its op ids and the accept path are untouched.
 */

export type ProposalGroup = "goal" | "personas" | "actors" | "needs" | "path" | "questions" | "other";

export interface ProposalSection {
  group: ProposalGroup;
  title: string;
  /** One line under the title, saying what the human decides here. */
  lead: string;
  entries: DiffEntry[];
}

const SECTIONS: Array<{ group: ProposalGroup; title: string; lead: string }> = [
  { group: "goal", title: "Goal", lead: "What the product is for. One statement; with several readings, you pick one." },
  { group: "personas", title: "Personas", lead: "People whose needs and steps the map models." },
  { group: "actors", title: "Other actors and roles", lead: "Involved, named, but their needs are not modelled." },
  { group: "needs", title: "Needs", lead: "What each persona needs, in the text's own words." },
  { group: "path", title: "Suggested main path", lead: "The ideal path from start to end, as steps in order." },
  { group: "questions", title: "Open questions", lead: "What the text leaves open. Each one becomes an open decision, never an answer." },
  { group: "other", title: "Other changes", lead: "Worst and best cases on steps." },
];

function groupOf(operation: PatchOperation): ProposalGroup {
  switch (operation.op) {
    case "set_goal":
      return "goal";
    case "add_persona":
      return operation.persona === false ? "actors" : "personas";
    case "add_need":
      return "needs";
    case "add_step":
    case "assign_persona":
    case "move_step":
      return "path";
    case "add_question":
      return "questions";
    case "add_wcbc":
      return "other";
  }
}

/** Sections in reading order; empty ones are left out. Every operation lands in exactly one. */
export function groupProposal(product: ProductDocument, patch: MapPatch): ProposalSection[] {
  const entries = new Map(describePatch(product, patch).map((entry) => [entry.opId, entry]));
  const byGroup = new Map<ProposalGroup, DiffEntry[]>();
  for (const operation of patch.operations) {
    const entry = entries.get(operation.opId);
    if (!entry) continue;
    const group = groupOf(operation);
    byGroup.set(group, [...(byGroup.get(group) ?? []), entry]);
  }
  return SECTIONS.flatMap((section) => {
    const list = byGroup.get(section.group);
    return list && list.length > 0 ? [{ ...section, entries: list }] : [];
  });
}

/** The goals offered as a choice, in proposal order. Empty when the proposal has at most one goal. */
export function goalChoice(patch: MapPatch): Array<{ opId: string; statement: string }> {
  const goals = patch.operations.flatMap((o) => (o.op === "set_goal" ? [{ opId: o.opId, statement: o.statement }] : []));
  return goals.length > 1 ? goals : [];
}

export interface Suggestion {
  label: string;
  text: string;
}

/**
 * What a field of a proposed item could say instead: the quote as written in
 * the source, and for a goal the other goals offered. Clicking one only fills
 * the field in the proposal draft; it writes nothing and decides nothing.
 */
export function suggestionsFor(patch: MapPatch, operation: PatchOperation, field: string): Suggestion[] {
  if (!EDITABLE_OP_FIELDS[operation.op].includes(field)) return [];
  const suggestions: Suggestion[] = [];
  const quote = operation.source.snippet.trim();
  if (quote !== "") suggestions.push({ label: "As written", text: quote });
  if (operation.op === "set_goal" && field === "statement")
    for (const other of goalChoice(patch))
      if (other.opId !== operation.opId) suggestions.push({ label: "Alternative", text: other.statement });
  return suggestions;
}

/** A short human label for a persona entry's roles, for the people sections. */
export function rolesLine(operation: PatchOperation): string {
  if (operation.op !== "add_persona" || !operation.roles || operation.roles.length === 0) return "";
  return operation.roles.map((role) => ROLE_LABEL[role]).join(", ");
}
