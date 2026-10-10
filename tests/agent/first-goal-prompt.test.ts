import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, repairSection } from "../../src/agent/prompt";

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

  it("says nowhere else in its rules that a goal may be left null (verifier, candidate e4531f6)", () => {
    const rules = SYSTEM_PROMPT.slice(0, SYSTEM_PROMPT.indexOf("Output format"));
    const goalAndNull = rules.split("\n").filter((line) => /\bgoal\b/i.test(line) && /\bnull\b/.test(line));
    expect(goalAndNull.map((line) => line.slice(0, 30))).toEqual(["- goal: a changed goal stateme", "- Use empty arrays where there"]);
  });

  it("keeps the rule for an existing map: a new goal only when the text clearly restates it", () => {
    expect(SYSTEM_PROMPT).toContain("only if the discussion clearly restates what the product is for");
  });

  it("no longer lets a first product's goal be null when the text does not state it", () => {
    expect(SYSTEM_PROMPT).not.toContain("propose the goal whenever the text says what the product is for");
    expect(SYSTEM_PROMPT).not.toContain("Use empty arrays and a null goal where there is nothing to propose.");
  });
});
