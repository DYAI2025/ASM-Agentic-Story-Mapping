import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NOTHING_CHANGED, UNREADABLE_HEADLINE, UNREADABLE_NEXT, unreadableAnswer } from "../../src/domain/proposal-failure";
import type { ValidationIssue } from "../../src/domain/validate";
import { ProposalIssues } from "../../src/ui/ProposalIssues";

const render = (issues: ValidationIssue[], reviewing = false) => renderToStaticMarkup(createElement(ProposalIssues, { issues, reviewing }));

/** `n` issues of the kind External QA saw: one per misplaced field of the answer. */
function shapeIssues(n: number): ValidationIssue[] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? { code: "agent_output_invalid_type", path: `needs.${i}.persona`, message: "Invalid input: expected string, received undefined" }
      : { code: "agent_output_unrecognized_keys", path: `steps.${i}`, message: 'Unrecognized keys: "sourceId", "snippet"' },
  );
}

/** The markup outside the disclosure: what is on screen before the human opens anything. */
const outsideDetails = (html: string) => html.replace(/<details[\s\S]*?<\/details>/g, "");
/** Tags stripped and the entities React writes decoded, so a test cannot pass on an escaped spelling. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("ASM-30: an answer in the wrong shape is one bounded message, the list behind a closed disclosure", () => {
  it("74 shape issues: headline, nothing changed, three next steps; every path only inside the closed disclosure", () => {
    const issues = shapeIssues(74);
    const html = render(issues);
    const visible = text(outsideDetails(html));
    expect(visible).toContain(UNREADABLE_HEADLINE);
    expect(visible).toContain(NOTHING_CHANGED);
    for (const step of UNREADABLE_NEXT) expect(visible).toContain(step);
    expect(visible).not.toMatch(/agent_output_|needs\.\d|steps\.\d|Unrecognized key|Invalid input/);
    // An alert, so a screen reader announces it, as it did the list before (verifier round 1).
    expect(html).toMatch(/^<div[^>]*role="alert"[^>]*data-testid="proposal-issues"/);
    // Static markup cannot see layout; it can see an element hidden outright. The browser test reads the screen.
    expect(html).not.toMatch(/\shidden(=|\s|>)|\sstyle=/);

    const details = /<details([^>]*)>([\s\S]*?)<\/details>/.exec(html);
    expect(details).not.toBeNull();
    expect(details![1]).not.toMatch(/\bopen\b/);
    expect(details![2]).toContain("Technical details (74 problems in the answer)");
    expect(details![2].match(/<li>/g)).toHaveLength(74);
    for (const issue of issues) expect(details![2]).toContain(issue.path);
  });

  it("bounded: what is on screen does not grow with the number of issues", () => {
    const visible = (n: number) => text(outsideDetails(render(shapeIssues(n))));
    expect(visible(200)).toBe(visible(1));
    expect(visible(200)).toBe(visible(4));
    expect(visible(200).length).toBeLessThanOrEqual(700);
  });

  it("one shape issue among others is enough: the answer as a whole was not read", () => {
    const mixed: ValidationIssue[] = [
      { code: "snippet_not_in_source", path: "personas[0].source.snippet", message: 'quote not found in source "src-1"' },
      ...shapeIssues(1),
    ];
    expect(unreadableAnswer(mixed)?.details).toEqual(mixed);
    const html = render(mixed);
    expect(text(outsideDetails(html))).toContain(UNREADABLE_HEADLINE);
    // The details are every issue, not only the shape ones, and the count says so (verifier round 1).
    const details = text(/<details[^>]*>([\s\S]*?)<\/details>/.exec(html)![1]);
    expect(details).toContain("Technical details (2 problems in the answer)");
    for (const issue of mixed) expect(details).toContain(`${issue.path} — ${issue.message} (${issue.code})`);
  });

  it("one problem is counted in the singular", () => {
    expect(text(render(shapeIssues(1)))).toContain("Technical details (1 problem in the answer)");
  });
});

/**
 * ASM-30 AC 4: failures that already say what is wrong keep their own words,
 * path and code, listed as before, with no summary and no disclosure.
 */
describe("ASM-30: specific failures keep their specific message", () => {
  const specific: Array<[string, ValidationIssue]> = [
    ["rejected credentials", { code: "provider_error", path: "openai", message: "OpenAI rejected the credentials; check OPENAI_API_KEY" }],
    ["timeout", { code: "provider_error", path: "anthropic", message: "Anthropic timed out after 120000 ms; try again or shorten the text" }],
    ["rate limit (429)", { code: "provider_error", path: "openai", message: "OpenAI rate limit reached; try again shortly" }],
    ["refusal", { code: "provider_error", path: "anthropic", message: "the model declined to process this text" }],
    ["quote not in the text", { code: "snippet_not_in_source", path: "personas[0].source.snippet", message: 'quote not found in source "src-1"' }],
    ["secret discarded", { code: "provider_error", path: "openai", message: "the model's output contained a configured secret and was discarded" }],
    ["nothing structured", { code: "nothing_structured", path: "transcript", message: "Nothing in the text could be turned into a map." }],
  ];

  it.each(specific)("%s: message, path and code on screen, no summary, no disclosure", (_, issue) => {
    expect(unreadableAnswer([issue])).toBeNull();
    const html = render([issue]);
    expect(html).not.toContain("<details");
    expect(html).not.toMatch(/\shidden(=|\s|>)|\sstyle=/);
    expect(text(html)).not.toContain(UNREADABLE_HEADLINE);
    const visible = text(html);
    expect(visible).toContain("No proposal.");
    expect(visible).toContain(issue.message);
    expect(visible).toContain(issue.path);
    expect(visible).toContain(`(${issue.code})`);
  });

  it("a refusal while reviewing keeps its heading", () => {
    const html = render([{ code: "unknown_id", path: "operations[0]", message: "no step with this id" }], true);
    expect(text(html)).toContain("This proposal cannot be accepted as it stands.");
  });

  it("no issues: nothing rendered", () => {
    expect(render([])).toBe("");
  });
});
