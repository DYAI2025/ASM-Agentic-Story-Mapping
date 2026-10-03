import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StartScreen } from "../../src/ui/StartScreen";
import { StoryMapEditor } from "../../src/ui/StoryMapEditor";
import { WorkshopPanel } from "../../src/ui/WorkshopPanel";
import { loadFixture } from "../domain/helpers";

const editor = () =>
  renderToStaticMarkup(createElement(StoryMapEditor, { initial: loadFixture(), initialSelection: null, initialPersonaCheck: null }));
const workshop = () =>
  renderToStaticMarkup(
    createElement(WorkshopPanel, { product: loadFixture(), onPreview: () => {}, onReviewing: () => {}, onAccepted: () => {} }),
  );
const start = () => renderToStaticMarkup(createElement(StartScreen, { markerHint: true }));

describe("clear input and start over are two different, visible actions", () => {
  it("the workshop panel has a clear-input button, disabled while there is nothing typed", () => {
    for (const html of [workshop(), start()]) {
      expect(html).toMatch(/<button[^>]*data-testid="clear-input"[^>]*disabled=""[^>]*>Clear input<\/button>/);
    }
  });

  it("the editor offers start over in its toolbar and shows no confirmation until asked", () => {
    const html = editor();
    expect(html).toMatch(/<button[^>]*data-testid="start-over"[^>]*>Start over…<\/button>/);
    expect(html).not.toContain('data-testid="start-over-dialog"');
    expect(html).not.toContain('data-testid="start-over-confirm"');
  });

  it("the start screen has nothing to start over from", () => {
    expect(start()).not.toContain('data-testid="start-over"');
  });
});
