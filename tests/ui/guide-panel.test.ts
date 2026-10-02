import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../../src/domain/fingerprint";
import { deriveGuide } from "../../src/domain/guide";
import { approveRevision, updateCard } from "../../src/domain/operations";
import type { ProductDocument } from "../../src/domain/schema";
import { selectSlice, type SliceSelection } from "../../src/domain/work-state";
import { GuidePanel } from "../../src/ui/GuidePanel";
import { loadFixture } from "../domain/helpers";

const APPROVAL = { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" };
const approved = (p: ProductDocument = loadFixture()) => approveRevision(p, APPROVAL);
const choose = (p: ProductDocument) =>
  selectSlice(p, { candidateId: "slice-outcome-thread", selectedBy: "Maya", selectedAt: "2026-10-02T09:00:00.000Z", mapFingerprint: fingerprint(p) });

const render = (product: ProductDocument, selection: SliceSelection | null, proposalOpen = false) =>
  renderToStaticMarkup(
    createElement(GuidePanel, { guide: deriveGuide(product, selection), proposalOpen, onAction: () => {}, onHide: () => {} }),
  );

/** The text of the element with this test id, or null when it is not rendered. */
function part(html: string, testId: string): string | null {
  const match = new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return match ? match[2].replace(/<[^>]+>/g, "") : null;
}
const currentSteps = (html: string) => html.match(/aria-current="step"/g)?.length ?? 0;
const cta = (html: string) => /<button[^>]*data-testid="guide-cta"[^>]*>([^<]*)<\/button>/.exec(html)?.[1];

describe("guide panel", () => {
  it("proposed map: one current step, its purpose and one call to action", () => {
    const html = render(loadFixture(), null);
    expect(html).toContain('data-current-step="approve"');
    expect(currentSteps(html)).toBe(1);
    expect(html).toMatch(/data-testid="guide-step-approve" data-status="current" aria-current="step"/);
    expect(part(html, "guide-progress")).toBe("3 of 6 steps done");
    expect(part(html, "guide-current-title")).toBe("Check the story and approve it");
    expect(cta(html)).toBe("Review and approve");
    expect(html.match(/data-testid="guide-cta"/g)).toHaveLength(1);
  });

  it("step titles avoid the internal terms canon, WCBC, fingerprint, revision, derivation and persona", () => {
    const html = render(loadFixture(), null);
    const titles = [...html.matchAll(/data-testid="guide-step-[\w]+"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
    expect(titles).toHaveLength(6);
    for (const title of titles) expect(title).not.toMatch(/canon|WCBC|fingerprint|revision|derivation|persona/i);
  });

  it("impact markers: only the ones the state has reached are rendered", () => {
    const proposed = render(loadFixture(), null);
    expect(proposed).toContain('data-testid="impact-map"');
    expect(proposed).not.toContain('data-testid="impact-sensemaking"');
    expect(proposed).not.toContain('data-testid="impact-delivery"');

    const p = approved();
    const selected = render(p, choose(p));
    expect(selected).toContain('data-testid="impact-sensemaking"');
    expect(selected).toContain('data-testid="impact-delivery"');
    expect(selected).toContain('data-current-step="complete"');
    expect(currentSteps(selected)).toBe(0);
    expect(part(selected, "guide-current-title")).toBe("All steps are done");
  });

  it("stale selection: explained, marked on its step, and the guide is back at approval", () => {
    const first = approved();
    const html = render(updateCard(first, "step-export-work", { description: "Changed after selection." }), choose(first));
    expect(html).toContain('data-current-step="approve"');
    expect(html).toContain('data-testid="guide-stale-select"');
    const note = part(html, "guide-stale-note")!;
    expect(note).toContain("the map has changed since the slice was selected.");
    expect(note).toContain("nothing was deleted or chosen for you");
    // It does not tell the human to select now: on a proposed map the gate would refuse that.
    expect(note).not.toContain("select a slice again");
    expect(note).toContain("You pick again at the step “Compare first slices and pick one”");
    expect(html).not.toContain('data-testid="impact-delivery"');
  });

  it("never selected: no stale marker, and the announcing region is there and empty", () => {
    const html = render(approved(), null);
    expect(html).not.toContain("guide-stale");
    expect(html).toContain('<div role="status" data-testid="guide-live"></div>');
  });

  it("the approval marker names the approver", () => {
    expect(part(render(approved(), null), "impact-sensemaking")).toBe("✓ The story is approved (by Ada)");
  });

  it("an open proposal comes first: the call to action points at it", () => {
    const html = render(loadFixture(), null, true);
    expect(cta(html)).toBe("Decide on the open proposal");
    expect(html.match(/data-testid="guide-cta"/g)).toHaveLength(1);
  });

  it("central actions are buttons, so they work from the keyboard", () => {
    const html = render(loadFixture(), null);
    expect(html).toMatch(/<button type="button" id="guide-cta"/);
    expect(html).toMatch(/<button type="button" class="secondary" data-testid="guide-hide"/);
  });
});
