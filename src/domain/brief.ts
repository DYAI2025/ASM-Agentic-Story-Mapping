import { fingerprint } from "./fingerprint";
import { reviewNarrative } from "./review";
import type { ProductDocument, WcbcOutcome } from "./schema";
import { criteriaFor, proposeSlices } from "./slices";
import type { ValidationIssue } from "./validate";

/**
 * Execution brief ("work order"): what leaves ASM once a human has selected a
 * slice of an approved narrative. Derived from the canonical document and
 * nothing else, so the same document always yields the same brief.
 *
 * ASM records approval; it verifies nothing. The brief says so.
 */

export const BRIEF_VERSION = 1 as const;

export interface ExecutionBrief {
  briefVersion: typeof BRIEF_VERSION;
  kind: "asm.execution-brief";
  goal: { id: string; statement: string; slice: { id: string; title: string } };
  approvedContext: {
    approval: { revision: number; approvedBy: string; approvedAt: string };
    selection: { candidateId: string; selectedBy: string; selectedAt: string };
    whyThisSlice: string[];
    assumptions: string[];
    decidedDecisions: { id: string; title: string; rationale: string; relatesTo: string[] }[];
    /** Always empty: ASM does not verify anything. */
    verified: string[];
    note: string;
  };
  inScope: {
    id: string;
    sequence: number;
    title: string;
    description: string;
    personaIds: string[];
    needIds: string[];
    branches: { id: string; kind: "worst_case" | "best_case"; title: string; description: string; recovery: string; outcome?: WcbcOutcome }[];
  }[];
  outOfScope: string[];
  personas: { id: string; name: string; description: string }[];
  needs: { id: string; personaId: string; statement: string }[];
  acceptanceCriteriaDraft: { id: string; text: string; refs: string[] }[];
  verificationExpectations: { criterionId: string; expectation: string }[];
  openHumanDecisions: { id: string; kind: "open_decision" | "review_gap" | "flag"; text: string; relatesTo: string[] }[];
  sourceMapRevision: {
    productId: string;
    productName: string;
    schemaVersion: number;
    revision: number;
    status: "approved";
    approvedBy: string;
    approvedAt: string;
    mapFingerprint: string;
  };
}

export type BriefResult = { ok: true; brief: ExecutionBrief } | { ok: false; issues: ValidationIssue[] };

const refuse = (code: string, path: string, message: string): BriefResult => ({ ok: false, issues: [{ code, path, message }] });

export function buildExecutionBrief(p: ProductDocument): BriefResult {
  const selection = p.selectedSlice;
  if (!selection)
    return refuse("selection_required", "selectedSlice", "no slice has been selected; a human has to select one before a work order can be exported");
  const approval = p.revision.approval;
  if (p.revision.status !== "approved" || !approval)
    return refuse("approval_required", "revision.status", "a work order can only be exported from an approved revision");
  const mapFingerprint = fingerprint(p);
  if (selection.revision !== p.revision.number || selection.mapFingerprint !== mapFingerprint)
    return refuse("stale_selection", "selectedSlice", "the map has changed since the slice was selected; select a slice again");

  const proposal = proposeSlices(p);
  const candidate = proposal.ok ? proposal.candidates.find((c) => c.id === selection.candidateId) : undefined;
  if (!candidate || candidate.stepIds.join(" ") !== selection.stepIds.join(" "))
    return refuse("stale_selection", "selectedSlice.candidateId", "the selected slice is not a candidate of this map; select a slice again");

  const included = new Set(selection.stepIds);
  const steps = [...p.narrative].sort((a, b) => a.sequence - b.sequence).filter((s) => included.has(s.id));
  const branches = p.wcbc.filter((b) => included.has(b.stepId));
  const inSlice = new Set([p.product.id, p.goal.id, ...selection.stepIds, ...selection.personaIds, ...selection.needIds, ...branches.map((b) => b.id)]);

  const criteria = criteriaFor(p, selection.stepIds).map((c, i) => ({ id: `ac-${i + 1}`, text: c.text, refs: c.refs }));
  const branchIds = new Set(branches.map((b) => b.id));

  const openDecisions = p.decisions.filter((d) => candidate.evidence.openDecisionIds.includes(d.id));
  const gaps = reviewNarrative(p).filter((f) => candidate.evidence.reviewGapIds.includes(f.id));

  return {
    ok: true,
    brief: {
      briefVersion: BRIEF_VERSION,
      kind: "asm.execution-brief",
      goal: { id: p.goal.id, statement: p.goal.statement, slice: { id: selection.candidateId, title: selection.title } },
      approvedContext: {
        approval: { revision: p.revision.number, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt },
        selection: { candidateId: selection.candidateId, selectedBy: selection.selectedBy, selectedAt: selection.selectedAt },
        whyThisSlice: candidate.whyNow,
        assumptions: candidate.assumptions,
        decidedDecisions: p.decisions
          .filter((d) => d.status === "decided" && d.relatesTo.some((ref) => inSlice.has(ref)))
          .map((d) => ({ id: d.id, title: d.title, rationale: d.rationale, relatesTo: [...d.relatesTo] })),
        verified: [],
        note: "Approved means a named human approved the narrative. ASM has verified nothing: no behaviour described here has been built or tested.",
      },
      inScope: steps.map((s) => ({
        id: s.id,
        sequence: s.sequence,
        title: s.title,
        description: s.description,
        personaIds: [...s.personaIds],
        needIds: [...s.needIds],
        branches: branches
          .filter((b) => b.stepId === s.id)
          .map((b) => ({
            id: b.id,
            kind: b.kind,
            title: b.title,
            description: b.description,
            recovery: b.recovery,
            ...(b.outcome ? { outcome: b.outcome } : {}),
          })),
      })),
      outOfScope: candidate.outOfScope,
      personas: p.personas.filter((e) => selection.personaIds.includes(e.id)).map((e) => ({ id: e.id, name: e.name, description: e.description })),
      needs: p.needs.filter((e) => selection.needIds.includes(e.id)).map((e) => ({ id: e.id, personaId: e.personaId, statement: e.statement })),
      acceptanceCriteriaDraft: criteria,
      verificationExpectations: criteria.map((c) => ({
        criterionId: c.id,
        expectation: branchIds.has(c.refs[0])
          ? `Provoke the situation of ${c.refs[0]} and show, with a recorded run, that what follows matches the criterion.`
          : `Show ${c.refs[0]} working for each named persona with a recorded run (test output or screen recording), not a description.`,
      })),
      openHumanDecisions: [
        ...openDecisions.map((d) => ({ id: d.id, kind: "open_decision" as const, text: d.title, relatesTo: [...d.relatesTo] })),
        ...gaps.map((f) => ({ id: f.id, kind: "review_gap" as const, text: f.message, relatesTo: [...f.relatesTo] })),
        ...candidate.flags.map((f, i) => ({ id: `flag-${i + 1}`, kind: "flag" as const, text: f.message, relatesTo: [] as string[] })),
      ],
      sourceMapRevision: {
        productId: p.product.id,
        productName: p.product.name,
        schemaVersion: p.schemaVersion,
        revision: p.revision.number,
        status: "approved",
        approvedBy: approval.approvedBy,
        approvedAt: approval.approvedAt,
        mapFingerprint,
      },
    },
  };
}

export function exportBriefJson(brief: ExecutionBrief): string {
  return `${JSON.stringify(brief, null, 2)}\n`;
}

function outcomeText(outcome: WcbcOutcome | undefined): string {
  if (!outcome) return "";
  if (outcome.kind === "recovery") return ` → resumes at \`${outcome.resumeStepId}\``;
  if (outcome.kind === "escalation") return ` → escalates to \`${outcome.toPersonaId}\``;
  return " → path ends";
}

export function exportBriefMarkdown(brief: ExecutionBrief): string {
  const bullets = (lines: string[]) => (lines.length > 0 ? lines.map((line) => `- ${line}`) : ["- None."]);
  const { approval, selection } = brief.approvedContext;
  const source = brief.sourceMapRevision;

  return [
    `# Work order: ${brief.goal.slice.title}`,
    "",
    `Slice \`${brief.goal.slice.id}\` of ${source.productName}, revision ${source.revision} (\`${source.mapFingerprint}\`).`,
    "",
    "## GOAL",
    "",
    `${brief.goal.statement} (\`${brief.goal.id}\`)`,
    "",
    "## VERIFIED / APPROVED CONTEXT",
    "",
    `- Approved: revision ${approval.revision} by ${approval.approvedBy} at ${approval.approvedAt}.`,
    `- Slice selected by ${selection.selectedBy} at ${selection.selectedAt}.`,
    `- Verified: nothing. ${brief.approvedContext.note}`,
    "",
    "Why this slice:",
    "",
    ...bullets(brief.approvedContext.whyThisSlice),
    "",
    "Assumptions:",
    "",
    ...bullets(brief.approvedContext.assumptions),
    "",
    "Decided:",
    "",
    ...bullets(brief.approvedContext.decidedDecisions.map((d) => `\`${d.id}\` ${d.title} — ${d.rationale}`)),
    "",
    "## IN SCOPE",
    "",
    ...brief.inScope.flatMap((step) => [
      `- Step ${step.sequence}: **${step.title}** (\`${step.id}\`) — ${step.description}`,
      ...step.branches.map(
        (b) =>
          `  - ${b.kind === "worst_case" ? "Worst case" : "Best case"} \`${b.id}\`: ${b.title}${b.recovery ? ` — ${b.recovery}` : ""}${outcomeText(b.outcome)}`,
      ),
    ]),
    "",
    "## OUT OF SCOPE",
    "",
    ...bullets(brief.outOfScope),
    "",
    "## PERSONAS / NEEDS",
    "",
    ...brief.personas.flatMap((persona) => [
      `- **${persona.name}** (\`${persona.id}\`) — ${persona.description}`,
      ...brief.needs.filter((n) => n.personaId === persona.id).map((n) => `  - \`${n.id}\` ${n.statement}`),
    ]),
    "",
    "## ACCEPTANCE CRITERIA DRAFT",
    "",
    "A draft derived from the map. A human has to confirm it before it binds anyone.",
    "",
    ...bullets(brief.acceptanceCriteriaDraft.map((c) => `**${c.id}** ${c.text}`)),
    "",
    "## VERIFICATION EXPECTATIONS",
    "",
    ...bullets(brief.verificationExpectations.map((v) => `**${v.criterionId}** ${v.expectation}`)),
    "",
    "## OPEN HUMAN DECISIONS",
    "",
    ...bullets(brief.openHumanDecisions.map((d) => `\`${d.id}\` (${d.kind.replace("_", " ")}) ${d.text}`)),
    "",
    "## SOURCE MAP REVISION",
    "",
    `- Product: ${source.productName} (\`${source.productId}\`), schema version ${source.schemaVersion}`,
    `- Revision: ${source.revision} (${source.status})`,
    `- Approved by: ${source.approvedBy} at ${source.approvedAt}`,
    `- Map fingerprint: \`${source.mapFingerprint}\``,
    "",
  ].join("\n");
}
