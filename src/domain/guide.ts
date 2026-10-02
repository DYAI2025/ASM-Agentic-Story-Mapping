import { buildExecutionBrief } from "./brief";
import { reviewNarrative } from "./review";
import type { ProductDocument } from "./schema";
import { validateProduct } from "./validate";
import { resolveSelection, type SliceSelection } from "./work-state";

/**
 * Guided flow: a projection of the product document and the work state.
 *
 * The guide owns no state and gates nothing. The three gated steps are read
 * from what the real gates read: the revision status (set by approval, or
 * carried by an imported file that records one), `resolveSelection` and
 * `buildExecutionBrief`.
 *
 * The first three steps say what a map needs before it is worth reviewing: a
 * valid document, someone with a need, a path of more than one step. No gate
 * requires them. They are the guide's own reading order, not a rule of the
 * product: a human who approves a map without them has decided so, and from
 * then on the guide follows the approval.
 *
 * A step is done only when every step before it is done, so the current step
 * is always the earliest one the real state has not reached, and a change
 * upstream leads back to it.
 *
 * An action never writes. It only says which part of the existing UI to open
 * or focus; the human acts there, through the existing gates.
 */

export type GuideStepId = "intent" | "people" | "main_path" | "approve" | "select" | "work_order";

export type GuideAction =
  /** The workshop input: where text becomes a proposal for the map. */
  | { kind: "focus_workshop"; label: string }
  /** The approval form, with the review findings open beside it. */
  | { kind: "focus_approval"; label: string }
  /** The slice drawer: candidates, selection, value exception and export. */
  | { kind: "open_slices"; label: string };

export interface GuideStep {
  id: GuideStepId;
  title: string;
  /** Why this step exists, in plain words. */
  purpose: string;
  status: "done" | "current" | "upcoming";
  /** Set when a stored result of this step exists and no longer matches the map: the reason. */
  stale?: string;
  action: GuideAction;
}

export type ImpactId = "map" | "sensemaking" | "delivery";

export interface GuideImpact {
  id: ImpactId;
  label: string;
  reached: boolean;
}

export interface GuideState {
  steps: GuideStep[];
  /** The earliest step that is not done; null when every step is done. */
  currentStepId: GuideStepId | null;
  doneCount: number;
  impacts: GuideImpact[];
}

/** What `resolveSelection` appends to every stale reason. The guide says when to select again itself. */
const RESELECT_HINT = /; select a slice again$/;

export function deriveGuide(product: ProductDocument, selection: SliceSelection | null): GuideState {
  const findings = reviewNarrative(product);
  const gaps = findings.filter((f) => f.level === "gap").length;
  const resolution = selection ? resolveSelection(product, selection) : null;
  const staleSelection = resolution && !resolution.ok ? resolution.issues[0].message.replace(RESELECT_HINT, "") : undefined;
  const approval = product.revision.status === "approved" ? product.revision.approval : undefined;
  const approved = product.revision.status === "approved";

  const reached: Record<GuideStepId, boolean> = {
    intent: approved || validateProduct(product).ok,
    people: approved || (product.personas.length > 0 && product.needs.length > 0),
    main_path: approved || !findings.some((f) => f.code === "main_path_missing" || f.code === "main_path_single_step"),
    approve: approved,
    select: resolution?.ok === true,
    work_order: buildExecutionBrief(product, selection).ok,
  };

  const definitions: Omit<GuideStep, "status">[] = [
    {
      id: "intent",
      title: "Say what you want to build",
      purpose: "Start from your own words. Notes or a conversation are enough; the map is built from them.",
      action: { kind: "focus_workshop", label: "Add notes or a conversation" },
    },
    {
      id: "people",
      title: "Name who is involved and what they need",
      purpose: "A product is for someone. Each step later points back to a person and a need.",
      action: { kind: "focus_workshop", label: "Add people and needs" },
    },
    {
      id: "main_path",
      title: "Lay out the ideal path",
      purpose: "One path from start to end, as it goes when everything works. Problems and exceptions come after.",
      action: { kind: "focus_workshop", label: "Add steps to the path" },
    },
    {
      id: "approve",
      title: "Check the story and approve it",
      purpose:
        gaps > 0
          ? `Read the map as a story. ${gaps} open point${gaps === 1 ? " is" : "s are"} listed for you to look at. Approval is yours alone: nothing is built on a story you have not approved.`
          : "Read the map as a story. Approval is yours alone: nothing is built on a story you have not approved.",
      action: { kind: "focus_approval", label: "Review and approve" },
    },
    {
      id: "select",
      title: "Compare first slices and pick one",
      purpose: "A slice is a small part of the path to build first. You see two or three side by side; the choice is yours.",
      ...(staleSelection ? { stale: staleSelection } : {}),
      action: { kind: "open_slices", label: "Compare slices" },
    },
    {
      id: "work_order",
      title: "Export the work order",
      purpose: "The work order hands your approved story and chosen slice to whoever builds it, tied to this exact version of the map.",
      action: { kind: "open_slices", label: "Open the work order" },
    },
  ];

  let open = true;
  let currentStepId: GuideStepId | null = null;
  const steps: GuideStep[] = definitions.map((definition) => {
    const done = open && reached[definition.id];
    const current = open && !done;
    if (current) currentStepId = definition.id;
    if (!done) open = false;
    return { ...definition, status: done ? "done" : current ? "current" : "upcoming" };
  });
  const done = (id: GuideStepId) => steps.some((s) => s.id === id && s.status === "done");

  return {
    steps,
    currentStepId,
    doneCount: steps.filter((s) => s.status === "done").length,
    impacts: [
      { id: "map", label: "Your thinking is a readable map", reached: done("main_path") },
      {
        id: "sensemaking",
        label: approval ? `The story is approved (by ${approval.approvedBy})` : "The story is approved",
        reached: done("approve"),
      },
      { id: "delivery", label: "A work order is ready to hand over", reached: done("work_order") },
    ],
  };
}
