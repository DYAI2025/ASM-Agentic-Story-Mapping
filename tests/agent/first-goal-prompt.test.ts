import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, repairSection, structureMessage } from "../../src/agent/prompt";
import { blankProduct } from "../../src/domain/bootstrap";
import { buildRequest } from "../../src/agent/anthropic-provider";

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
 *
 * The golden file holds everything the model is told on a first-product
 * request and its repair request, for a pasted source and a file, and the
 * request the Anthropic provider sends with its own output schema. The
 * OpenAI and OpenRouter adapters send the same texts and OUTPUT_CONTRACT; the
 * name they wrap the schema in is not held here. Any change to what the model is told, in any part and in
 * any words, fails until that file is changed with it, on purpose, in the same
 * commit: looking for particular words left the next wording through three
 * times (external review round 7; the verifier on e4531f6, 4eef537, a8866d5).
 * The sentences checked one by one say what the rule is for.
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

  it("pins, word for word, everything the model is told on a first-product request and its repair request, as the reference provider sends it", async () => {
    const blank = blankProduct("Rota Care");
    if (!blank.ok) throw new Error(JSON.stringify(blank.issues));
    // One pasted source and one file: part of what the model is told appears only for a file or for several sources (verifier, d673646).
    const input = {
      context: {
        sources: [
          { id: "src-1", label: "Pasted text", kind: "pasted" as const, text: "Kick-off notes. Maya: the night shift keeps swapping by text message and nobody knows who is on." },
          { id: "src-2", label: "rota-rules.md", kind: "file" as const, text: "Nurses may swap a shift up to 24 hours before it starts." },
        ],
      },
      product: blank.product,
      repair: { problems: ["goal.source.snippet: not found in src-1"], omitted: 0 },
    };
    const nonce = "0123456789abcdef";
    const request = structureMessage(input, nonce);
    // The request the Anthropic provider sends (the reference path since ASM-34), with its own output schema;
    // each call draws a fresh delimiter nonce, which is the one part set to the fixed value here.
    const sent = buildRequest(input, "claude-haiku-5-5");
    const sentMessage = sent.messages[0].content.replace(/(<\/?transcript-[0-9a-f]{8}-)[0-9a-f]{16}(-src-\d+>)/g, `$1${nonce}$2`);
    expect(sent.system).toBe(SYSTEM_PROMPT);
    expect(sentMessage).toBe(request);
    const shape = JSON.stringify({ ...sent, system: "<the system prompt above>", messages: [{ role: sent.messages[0].role, content: "<the request above>" }] }, null, 2);
    const told = [
      "=== system prompt",
      SYSTEM_PROMPT,
      "",
      "=== request, with the repair section",
      request,
      "",
      "=== as the Anthropic provider sends it",
      shape,
      "",
    ].join("\n");
    await expect(told).toMatchFileSnapshot("./golden/model-instructions.golden.txt");
  });

  it("keeps the rule for an existing map: a new goal only when the text clearly restates it", () => {
    expect(SYSTEM_PROMPT).toContain("only if the discussion clearly restates what the product is for");
  });

  it("no longer lets a first product's goal be null when the text does not state it", () => {
    expect(SYSTEM_PROMPT).not.toContain("propose the goal whenever the text says what the product is for");
    expect(SYSTEM_PROMPT).not.toContain("Use empty arrays and a null goal where there is nothing to propose.");
  });
});
