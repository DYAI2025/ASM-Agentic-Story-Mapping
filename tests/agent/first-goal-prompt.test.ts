import { describe, expect, it } from "vitest";
import { OUTPUT_CONTRACT, SYSTEM_PROMPT, repairSection } from "../../src/agent/prompt";

/**
 * ASM-34 §11 (PO decision 2026-10-10, after the battery 3/5 on 7f561e0): on
 * the External-QA kickoff transcript (A3) and the three short notes (A5) the
 * model left the goal of a first product empty, because the text states the
 * purpose only implicitly or not at all, and the first-time user got "add one
 * sentence that says what the product is for" instead of a proposal. One rule
 * in the system prompt changes that: a first product always gets a proposed
 * goal, from the passage closest to its purpose and quoted exactly, with the
 * other readings as alternatives for the human to choose (ASM-31 gate). What
 * the human decides does not change; whether the model follows the rule is
 * measured by the battery, not here.
 */

/**
 * Every line the model receives that speaks of the goal or the product's
 * purpose, in the request and in the repair request, as the product owner
 * decided it (ASM-34 §11). A new or changed instruction about the goal fails
 * here until this list is changed with it, on purpose: patterns for one
 * wording of a contradiction did not catch the next (verifier, 4eef537). A new
 * line that speaks of neither is not caught; the review reads those.
 */
const SYSTEM_GOAL_LINES = [
  "- The current map as JSON: goal, personas, needs and narrative steps, each with an id.",
  "- goal: a changed goal statement, only if the discussion clearly restates what the product is for. Otherwise null. If the current map has an empty goal statement, this is a first product with no goal yet: always propose a goal. Take it from the passage that comes closest to saying what the product is for, put it in the text's own terms, and quote that passage exactly as its source. When the text only implies the purpose, or supports more than one reading of it, give the other readings as goalAlternatives, each with its own exact quote; the human chooses. When no passage says what the product is for, still propose the closest reading: give it a low confidence, say in its rationale that the text does not state the purpose, and add an unresolved question asking what the product is for. Never leave the goal of a first product null.",
  "- goalAlternatives: when the text supports more than one reading of what the product is for, the other readings, each with its own source. The human chooses between goal and goalAlternatives; do not merge them into one statement. Empty when there is one reading.",
  "- Prefer an unresolved question over a guess (for the goal of a first product, give both: the closest reading and the question). A short proposal that is well supported is better than a long one that is not.",
  "- A snippet is copied character for character: a run of consecutive words exactly as they stand in that one source, usually 4 to 20 words. Keep its spelling, capitalisation, punctuation and quotation marks; do not paraphrase, summarise, shorten with \"…\", translate, correct, or join text from two places or two sources. Every snippet is checked against its source, and a single snippet that is not found there makes the whole proposal unusable: prefer a short exact quote, and leave an item out when no passage supports it (the goal of a first product is the one exception: it is always proposed, as described under goal).",
  "- Use empty arrays where there is nothing to propose, and a null goal only on an existing map whose goal the text does not restate.",
];

const REPAIR_GOAL_LINES = [
  "Answer again from the sources above, with the complete proposal in exactly this format. The format is binding: use exactly these field names and this nesting, put every snippet, rationale, confidence and source id inside the item's \"source\" object, give every property (null or an empty array where there is nothing), and add no other field. Every rule above still applies: every snippet is copied character for character from the one source it names (if you cannot find an exact passage for an item, leave the item out; the goal of a first product is the one exception: it is always proposed, as described above), every new: ref is lowercase letters, digits and hyphens and declared once, every role is one from the list, and every id you refer to is on the map or declared in your answer.",
];

const goalLines = (text: string) =>
  text.replace(OUTPUT_CONTRACT, "").split("\n").filter((line) => /goal|purpose|what the product is for/i.test(line));

describe("a first product always gets a proposed goal (ASM-34 §11)", () => {
  it("asks for a goal on a first product, from the passage closest to the purpose, quoted exactly", () => {
    expect(SYSTEM_PROMPT).toContain("this is a first product with no goal yet: always propose a goal");
    expect(SYSTEM_PROMPT).toContain("the passage that comes closest to saying what the product is for");
    expect(SYSTEM_PROMPT).toContain("quote that passage exactly as its source");
    expect(SYSTEM_PROMPT).toContain("Never leave the goal of a first product null");
  });

  it("offers the other readings of an implied purpose as alternatives for the human to choose", () => {
    expect(SYSTEM_PROMPT).toMatch(/only implies the purpose[^\n]*goalAlternatives[^\n]*the human chooses/);
  });

  it("where no passage says what the product is for, still proposes the closest reading, marked as uncertain and asked about", () => {
    expect(SYSTEM_PROMPT).toContain(
      "When no passage says what the product is for, still propose the closest reading: give it a low confidence, say in its rationale that the text does not state the purpose, and add an unresolved question asking what the product is for.",
    );
  });

  it("names the goal of a first product as the exception to the rules that would leave it out (review round 7)", () => {
    expect(SYSTEM_PROMPT).toMatch(/leave an item out when no passage supports it \(the goal of a first product is the one exception/);
    expect(SYSTEM_PROMPT).toMatch(/Prefer an unresolved question over a guess \(for the goal of a first product, give both/);
  });

  it("keeps the exception on the repair request, which otherwise tells the model to leave out what it cannot quote (verifier, candidate e4531f6)", () => {
    expect(repairSection({ problems: ["goal.source.snippet: not found in src-1"], omitted: 0 })).toMatch(
      /if you cannot find an exact passage for an item, leave the item out; the goal of a first product is the one exception: it is always proposed, as described above\)/,
    );
  });

  it("speaks of the goal only in the lines decided for it, in the request and in the repair request (verifier, candidates e4531f6 and 4eef537)", () => {
    expect(goalLines(SYSTEM_PROMPT)).toEqual(SYSTEM_GOAL_LINES);
    expect(goalLines(repairSection({ problems: [], omitted: 0 }))).toEqual(REPAIR_GOAL_LINES);
  });

  it("keeps the rule for an existing map: a new goal only when the text clearly restates it", () => {
    expect(SYSTEM_PROMPT).toContain("only if the discussion clearly restates what the product is for");
  });

  it("no longer lets a first product's goal be null when the text does not state it", () => {
    expect(SYSTEM_PROMPT).not.toContain("propose the goal whenever the text says what the product is for");
    expect(SYSTEM_PROMPT).not.toContain("Use empty arrays and a null goal where there is nothing to propose.");
  });
});
