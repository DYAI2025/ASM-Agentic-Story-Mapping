import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deriveGuide } from "../../src/domain/guide";
import { GuidePanel } from "../../src/ui/GuidePanel";
import { StartScreen } from "../../src/ui/StartScreen";
import { StoryMapEditor } from "../../src/ui/StoryMapEditor";
import { TUTORIAL_STEPS, TutorialCard } from "../../src/ui/Tutorial";
import { loadFixture } from "../domain/helpers";

/**
 * ASM-27: a short tutorial about how ASM is used, separate from the Product
 * Flow, which says where the product stands. Tutorial state is browser state;
 * it can reach nothing that decides anything.
 */
function part(html: string, testId: string): string | null {
  const match = new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return match ? match[2].replace(/<[^>]+>/g, "") : null;
}

const card = (step: number) =>
  renderToStaticMarkup(createElement(TutorialCard, { step, onNext: () => {}, onBack: () => {}, onSkip: () => {}, onFinish: () => {} }));

describe("the tutorial says how ASM is used, in four steps, verbatim from the contract", () => {
  it("has exactly these four steps", () => {
    expect(TUTORIAL_STEPS).toEqual([
      { title: "Bring what you already have", text: "Paste notes, a meeting transcript, a product description or rough thoughts." },
      { title: "Review, don't rewrite", text: "ASM extracts Goals, People, Needs and a Product Journey. You decide what is true." },
      { title: "Check the story", text: "ASM surfaces missing steps, open questions and worst cases." },
      { title: "Turn understanding into work", text: "Approve the Narrative, compare first Slices and create a Work Order." },
    ]);
  });

  it("renders one step at a time as a labelled dialog with Skip, Back/Next, and Finish only at the end", () => {
    const first = card(1);
    expect(first).toMatch(/<section[^>]*role="dialog"[^>]*aria-labelledby="tutorial-title"[^>]*data-testid="tutorial"[^>]*data-step="1"/);
    expect(part(first, "tutorial-title")).toBe("Bring what you already have");
    expect(part(first, "tutorial-text")).toBe("Paste notes, a meeting transcript, a product description or rough thoughts.");
    expect(part(first, "tutorial-progress")).toBe("Step 1 of 4 · How ASM is used");
    expect(first).toContain('data-testid="tutorial-skip"');
    expect(first).toContain('data-testid="tutorial-next"');
    expect(first).not.toContain('data-testid="tutorial-back"');
    expect(first).not.toContain('data-testid="tutorial-finish"');

    const last = card(4);
    expect(part(last, "tutorial-title")).toBe("Turn understanding into work");
    expect(last).toContain('data-testid="tutorial-back"');
    expect(last).toContain('data-testid="tutorial-finish"');
    expect(last).not.toContain('data-testid="tutorial-next"');
    expect(last).not.toContain('data-testid="tutorial-skip"');
  });

  it("never names product content or a decision: it explains the principle and who decides", () => {
    for (const step of TUTORIAL_STEPS) expect(`${step.title} ${step.text}`).not.toMatch(/canon|fingerprint|revision|derivation|op-\d|approver name|selector name/i);
    expect(TUTORIAL_STEPS.map((s) => s.text).join(" ")).toContain("You decide what is true.");
  });

  it("the start screen and the map both offer a way to show it again", () => {
    const start = renderToStaticMarkup(createElement(StartScreen, { markerHint: true }));
    const editor = renderToStaticMarkup(createElement(StoryMapEditor, { initial: loadFixture(), initialSelection: null, initialPersonaCheck: null }));
    for (const html of [start, editor]) expect(html).toMatch(/<button[^>]*data-testid="tutorial-replay"[^>]*>Show tutorial<\/button>/);
    // Not shown on the server render: whether this viewer has seen it is only known in the browser.
    for (const html of [start, editor]) expect(html).not.toContain('data-testid="tutorial"');
  });
});

describe("the Product Flow is the guide, renamed, and the tutorial cannot touch it", () => {
  it("the panel calls itself Product Flow and keeps its identifiers", () => {
    const product = loadFixture();
    const html = renderToStaticMarkup(createElement(GuidePanel, { guide: deriveGuide(product, null, null), proposalOpen: false, onAction: () => {}, onHide: () => {} }));
    expect(html).toMatch(/<section[^>]*aria-label="Product Flow"[^>]*data-testid="guide"/);
    expect(html).toMatch(/<h2>Product Flow/);
    expect(part(html, "guide-lead")).toBe("Where the product stands, read from the map and the work state; nothing here is a tutorial.");
    expect(html).toMatch(/data-testid="guide-hide"[^>]*>Hide product flow</);
    expect(html).not.toMatch(/<h2>Guide/);
  });

  it("nothing about the tutorial exists in the domain, and the tutorial reaches nothing but the browser", () => {
    const root = path.join(__dirname, "..", "..", "src");
    for (const file of ["domain/guide.ts", "domain/work-state.ts", "domain/schema.ts", "domain/bootstrap.ts"]) {
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(/tutorial/i);
    }
    const tutorial = readFileSync(path.join(root, "ui", "Tutorial.tsx"), "utf8");
    expect(tutorial).not.toMatch(/from "\.\.\/domain\//);
    expect(tutorial).not.toMatch(/from "\.\.\/server\//);
    expect(tutorial).not.toMatch(/\bfetch\(/);
    expect(tutorial).not.toMatch(/asm\.guide/);
    expect(tutorial).toMatch(/asm\.tutorial/);
    // deriveGuide takes the product and the two pieces of work state (the check has a default), nothing else.
    const signature = /export function deriveGuide\(([^)]*)\)/.exec(readFileSync(path.join(root, "domain", "guide.ts"), "utf8"))![1];
    expect(signature.split(",").map((p) => p.trim().split(/[:\s]/)[0])).toEqual(["product", "selection", "personaCheck"]);
    expect(deriveGuide.length).toBe(2);
  });
});
