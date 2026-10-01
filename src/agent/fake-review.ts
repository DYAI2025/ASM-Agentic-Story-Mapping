import type { AgentReviewOutput } from "../domain/review";
import type { ProductDocument } from "../domain/schema";

/**
 * Deterministic review without any model. It does not understand the
 * narrative; it applies five fixed rules and words its findings from
 * templates:
 *
 *   missing_wcbc              a step without a worst case -> NEW_PROPOSAL wcbc
 *   missing_transition        two neighbouring steps that share no persona
 *   implementation_wording    a step whose text names technology
 *   conflicting_descriptions  two steps with the same title
 *   missing_product_question  a step with three or more personas -> NEW_PROPOSAL question
 *
 * It is the default provider and the one all tests run against.
 */

const TECHNOLOGY =
  /\b(api|apis|endpoint|database|db|sql|table|json|yaml|xml|http|https|backend|frontend|server|microservice|schema|cron|webhook|cache|queue)\b/i;

const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

export function reviewWithRules(product: ProductDocument): AgentReviewOutput {
  const findings: AgentReviewOutput["findings"] = [];
  const steps = [...product.narrative].sort((a, b) => a.sequence - b.sequence);
  const personaName = new Map(product.personas.map((e) => [e.id, e.name]));
  const names = (ids: string[]) => ids.map((id) => personaName.get(id) ?? id).join(", ");

  for (const step of steps) {
    if (product.wcbc.some((b) => b.stepId === step.id && b.kind === "worst_case")) continue;
    findings.push({
      kind: "missing_wcbc",
      message: `Step “${step.title}” has no worst case: the map does not say what happens when it cannot be completed.`,
      relatesTo: [step.id],
      evidence: { snippet: step.title, rationale: "No worst-case branch is attached to this step.", confidence: 0.5 },
      proposal: {
        type: "NEW_PROPOSAL",
        item: "wcbc",
        step: step.id,
        kind: "worst_case",
        title: `${step.title} cannot be completed`,
        description: "Template suggestion: say what goes wrong here before accepting it as it stands.",
        recovery: `Return to “${step.title}” and try again.`,
        outcome: { kind: "recovery", step: step.id, persona: null },
      },
    });
  }

  for (let i = 0; i + 1 < steps.length; i++) {
    const [from, to] = [steps[i], steps[i + 1]];
    if (from.personaIds.length === 0 || to.personaIds.length === 0) continue;
    if (from.personaIds.some((id) => to.personaIds.includes(id))) continue;
    findings.push({
      kind: "missing_transition",
      message: `“${from.title}” is done by ${names(from.personaIds)} and “${to.title}” by ${names(to.personaIds)}; the map does not say how the work gets from one to the other.`,
      relatesTo: [from.id, to.id],
      evidence: { snippet: to.title, rationale: "Neighbouring steps share no persona.", confidence: 0.5 },
      proposal: null,
    });
  }

  for (const step of steps) {
    const hit = [step.title, step.description].find((text) => TECHNOLOGY.test(text));
    if (!hit) continue;
    findings.push({
      kind: "implementation_wording",
      message: `Step “${step.title}” names technology (“${TECHNOLOGY.exec(hit)![0]}”) instead of what the persona does.`,
      relatesTo: [step.id],
      evidence: { snippet: hit, rationale: "The wording describes an implementation, not a behaviour.", confidence: 0.5 },
      proposal: null,
    });
  }

  const byTitle = new Map<string, typeof steps>();
  for (const step of steps) byTitle.set(key(step.title), [...(byTitle.get(key(step.title)) ?? []), step]);
  for (const same of byTitle.values()) {
    if (same.length < 2) continue;
    findings.push({
      kind: "conflicting_descriptions",
      message: `${same.length} steps are called “${same[0].title}”; it is unclear whether they are the same step.`,
      relatesTo: same.map((s) => s.id),
      evidence: { snippet: same[0].title, rationale: "Several steps carry the same title.", confidence: 0.5 },
      proposal: null,
    });
  }

  for (const step of steps) {
    if (step.personaIds.length < 3) continue;
    findings.push({
      kind: "missing_product_question",
      message: `${step.personaIds.length} personas take part in “${step.title}”; the map does not say who leads it.`,
      relatesTo: [step.id],
      evidence: { snippet: step.title, rationale: "Three or more personas share one step.", confidence: 0.5 },
      proposal: { type: "NEW_PROPOSAL", item: "question", question: `Who leads “${step.title}” when ${names(step.personaIds)} all take part?` },
    });
  }

  return {
    summary: `${findings.length} finding(s) from fixed rules; no model was involved.`,
    findings,
  };
}
