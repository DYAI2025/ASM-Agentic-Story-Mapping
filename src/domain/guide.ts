import { isPersona } from "./actors";
import { blankProduct } from "./bootstrap";
import { buildExecutionBrief } from "./brief";
import { reviewNarrative } from "./review";
import type { ProductDocument } from "./schema";
import { proposeSlices } from "./slices";
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
 * valid document, personas who each have a need, a path of more than one step. No gate
 * requires them. They are the guide's own reading order, not a rule of the
 * product: a human who approves a map without them has decided so, and from
 * then on the guide follows the approval. Such a step is marked as approved
 * as it is, never as complete, and the map marker stays off.
 *
 * Where the next gated step cannot be done on the map as it is (no slice can
 * be derived from it), the step says why, in the words of the function that
 * refuses, and points back at the input instead of at a dead end.
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
  /** Done only because a human approved the map without it. What the step asks for is not on the map. */
  approvedAsIs?: true;
  /** The step cannot be done on the map as it is: the reason, from the function that refuses. */
  blocked?: string;
  /** Something the human should know before acting on this step, in the words of the gate that will refuse. */
  warning?: string;
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

/**
 * The guide before any product exists: the blank draft is read like any other
 * state. It is not a valid product, so the first step is the current one.
 */
export function deriveStartGuide(): GuideState {
  const blank = blankProduct("New product");
  if (!blank.ok) throw new Error("the blank draft could not be built");
  return deriveGuide(blank.product, null);
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

  /** What the first three steps ask for, as it is on the map. */
  const present = {
    intent: validateProduct(product).ok,
    // Someone whose needs are modelled, and no persona left without a need.
    people: product.personas.some(isPersona) && !findings.some((f) => f.code === "persona_without_need"),
    main_path: !findings.some((f) => f.code === "main_path_missing" || f.code === "main_path_single_step"),
  };
  const brief = buildExecutionBrief(product, selection);
  const candidates = proposeSlices(product);
  const noCandidates = candidates.ok ? undefined : candidates.issues.map((i) => i.message).join("; ");

  const reached: Record<GuideStepId, boolean> = {
    intent: approved || present.intent,
    people: approved || present.people,
    main_path: approved || present.main_path,
    approve: approved,
    select: resolution?.ok === true,
    work_order: brief.ok,
  };
  /** Why the export gate refuses, once a slice is selected. Before that the reason is simply that nothing is selected. */
  const noWorkOrder = !brief.ok && resolution?.ok ? brief.issues.map((i) => i.message).join("; ") : undefined;

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
      // Known before approval, so it is said before approval: approving this map would lead to a step that cannot be done.
      ...(noCandidates && !approved ? { warning: `As the map is now, no first slice can be derived from it after approval: ${noCandidates}` } : {}),
      action: { kind: "focus_approval", label: "Review and approve" },
    },
    {
      id: "select",
      title: "Compare first slices and pick one",
      purpose: "A slice is a small part of the path to build first. You see two or three side by side; the choice is yours.",
      ...(staleSelection ? { stale: staleSelection } : {}),
      ...(noCandidates
        ? { blocked: noCandidates, action: { kind: "focus_workshop" as const, label: "Add to the map" } }
        : { action: { kind: "open_slices" as const, label: "Compare slices" } }),
    },
    {
      id: "work_order",
      title: "Export the work order",
      purpose: "The work order hands your approved story and chosen slice to whoever builds it, tied to this exact version of the map.",
      ...(noWorkOrder ? { warning: `No work order can be exported yet: ${noWorkOrder}` } : {}),
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
    const asIs = done && definition.id in present && !present[definition.id as keyof typeof present];
    return { ...definition, status: done ? "done" : current ? "current" : "upcoming", ...(asIs ? { approvedAsIs: true as const } : {}) };
  });
  const onTheMap = present.intent && present.people && present.main_path;
  const done = (id: GuideStepId) => steps.some((s) => s.id === id && s.status === "done");

  return {
    steps,
    currentStepId,
    doneCount: steps.filter((s) => s.status === "done").length,
    impacts: [
      { id: "map", label: "Your thinking is a readable map", reached: onTheMap && done("main_path") },
      {
        id: "sensemaking",
        label: approval ? `The story is approved (by ${approval.approvedBy})` : "The story is approved",
        reached: done("approve"),
      },
      { id: "delivery", label: "A work order is ready to hand over", reached: done("work_order") },
    ],
  };
}
