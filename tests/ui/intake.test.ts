import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StartScreen } from "../../src/ui/StartScreen";
import { WorkshopPanel } from "../../src/ui/WorkshopPanel";
import { loadFixture } from "../domain/helpers";

const start = (markerHint: boolean) => renderToStaticMarkup(createElement(StartScreen, { markerHint }));
const workshop = () =>
  renderToStaticMarkup(
    createElement(WorkshopPanel, { product: loadFixture(), onPreview: () => {}, onReviewing: () => {}, onAccepted: () => {} }),
  );

/** The text of the element with this test id, tags stripped; null when absent. */
function part(html: string, testId: string): string | null {
  const match = new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return match ? match[2].replace(/<[^>]+>/g, "") : null;
}

/**
 * ASM-24: the primary flow asks for what the user already has, in their words.
 * The marker format is a note for the no-model case, never the first thing read.
 */
describe("the start screen asks for existing material, not ASM syntax", () => {
  it.each([true, false])("the heading and intro are the same with and without a model (markerHint=%s)", (markerHint) => {
    const html = start(markerHint);
    expect(html).toContain("What do you want to build or improve?");
    expect(part(html, "intake-intro")).toBe(
      "Paste anything you already have: meeting notes, a transcript, a product description, requirements or rough thoughts. The text is treated as material to analyse, never as instructions; nothing is saved until you accept a proposal.",
    );
    expect(part(html, "intake-intro")).not.toMatch(/Goal:|Persona:|Step:/);
    // The placeholder does not teach a syntax either.
    expect(html).not.toMatch(/placeholder="Goal:/);
  });

  it("with no model connected the marker format is a collapsed note below the field, not the instruction", () => {
    const html = start(true);
    expect(html).toMatch(/<details[^>]*data-testid="marker-hint"/);
    expect(html.indexOf('data-testid="transcript-input"')).toBeLessThan(html.indexOf('data-testid="marker-hint"'));
    expect(start(false)).not.toContain('data-testid="marker-hint"');
  });

  it("text and markdown files can be added, several at once, on the start screen and in the workshop", () => {
    for (const html of [start(false), workshop()]) {
      expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="\.txt,\.md"[^>]*multiple=""[^>]*data-testid="context-files"/);
      expect(html).toContain("Add text or markdown files");
      expect(html).not.toContain('data-testid="context-source-');
    }
  });

  it("the name field explains itself and no longer gates the button by itself", () => {
    const html = start(false);
    expect(html).toContain("A working name is enough; the ids on the map are made from it.");
    expect(html).not.toContain("Give the product a name first.");
  });
});
