import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../../src/agent/prompt";

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

  it("keeps the rule for an existing map: a new goal only when the text clearly restates it", () => {
    expect(SYSTEM_PROMPT).toContain("only if the discussion clearly restates what the product is for");
  });

  it("no longer lets a first product's goal be null when the text does not state it", () => {
    expect(SYSTEM_PROMPT).not.toContain("propose the goal whenever the text says what the product is for");
    expect(SYSTEM_PROMPT).not.toContain("Use empty arrays and a null goal where there is nothing to propose.");
  });
});
