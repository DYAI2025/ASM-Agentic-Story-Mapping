import type { ValidationIssue } from "./validate";

/**
 * What a human reads when the model's answer could not be read (ASM-30). The
 * output contract refuses an answer in the wrong shape with one issue per
 * misplaced field (`agent_output_*`), often dozens; those are diagnostics for
 * whoever runs the model, not something a Product Lead can act on. So the
 * screen says what happened, that nothing changed and what to try, in the
 * same few sentences whatever the number of issues, and keeps the list for
 * whoever asks for it. Every other refusal keeps its own words: a provider
 * failure, a quote not in the text or a file that cannot be read already says
 * what is wrong.
 */
export interface UnreadableAnswer {
  headline: string;
  unchanged: string;
  next: string[];
  /** Every issue, as the server returned it; shown only on request. */
  details: readonly ValidationIssue[];
}

export const UNREADABLE_HEADLINE = "The model's answer could not be read safely, so ASM did not use it.";
export const NOTHING_CHANGED = "Nothing was changed.";
export const UNREADABLE_NEXT = [
  "Try again: the model may answer in the expected form the next time.",
  "If it fails again, shorten the text or split it into smaller parts.",
  "If it keeps failing, the configured model may not follow ASM's format; another one can be set on the server (ASM_AGENT_MODEL).",
];

/** The bounded message, when any issue says the answer's shape was refused; null when the issues speak for themselves. */
export function unreadableAnswer(issues: readonly ValidationIssue[]): UnreadableAnswer | null {
  if (!issues.some((issue) => issue.code.startsWith("agent_output_"))) return null;
  return { headline: UNREADABLE_HEADLINE, unchanged: NOTHING_CHANGED, next: UNREADABLE_NEXT, details: issues };
}
