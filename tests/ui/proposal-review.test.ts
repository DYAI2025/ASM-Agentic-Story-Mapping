import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { structureWithMarkers } from "../../src/agent/fake-provider";
import { blankProduct } from "../../src/domain/bootstrap";
import { resolveProposal, type MapPatch } from "../../src/domain/map-patch";
import type { ProductDocument } from "../../src/domain/schema";
import { ProposalReview } from "../../src/ui/ProposalReview";

/**
 * ASM-26: the review shows product meaning in groups; every item can be used,
 * edited or rejected on its own; a goal with alternatives is a choice nobody
 * makes for the human; the source sits behind a disclosure; suggestions are
 * chips on the field being edited.
 */
const TEXT = [
  "Goal: Residents collect a parcel without waiting for a courier.",
  "Goal: Couriers deliver to the building in one stop.",
  "Persona: Resident — Lives in the building. [roles: customer, user]",
  "Actor: Building manager — Owns the lobby. [roles: stakeholder]",
  "Need (Resident): Get my parcel on the day it arrives.",
  "Step: Resident opens the compartment — With the code. [personas: Resident] [needs: Get my parcel on the day it arrives]",
  "Do oversized parcels go somewhere else?",
].join("\n");

function proposal(): { product: ProductDocument; patch: MapPatch } {
  const blank = blankProduct("Parcel lockers");
  if (!blank.ok) throw new Error("blank");
  const result = resolveProposal(blank.product, structureWithMarkers(TEXT, blank.product), TEXT, "test");
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return { product: blank.product, patch: result.patch };
}

const render = (overrides: Partial<Parameters<typeof ProposalReview>[0]> = {}) => {
  const { product, patch } = proposal();
  return renderToStaticMarkup(
    createElement(ProposalReview, {
      product,
      patch,
      excluded: new Set<string>(),
      editing: new Set<string>(),
      onToggle: () => {},
      onChooseGoal: () => {},
      onEdit: () => {},
      onEditToggle: () => {},
      ...overrides,
    }),
  );
};

/** Whether an <input> with all of these attribute fragments exists, in any attribute order. */
function input(html: string, ...fragments: string[]): boolean {
  return new RegExp(`<input${fragments.map((f) => `(?=[^>]*${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`).join("")}[^>]*/?>`).test(html);
}

function part(html: string, testId: string): string | null {
  const match = new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return match ? match[2].replace(/<[^>]+>/g, "") : null;
}

describe("the proposal review shows product meaning, grouped", () => {
  it("sections in reading order with their titles, every op in one of them, ids kept", () => {
    const html = render();
    const order = ["goal", "personas", "actors", "needs", "path", "questions"].map((g) => html.indexOf(`data-testid="proposal-section-${g}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("<h3>Goal");
    expect(html).toContain("<h3>Suggested main path");
    expect(html).toContain("<h3>Open questions");
    for (const id of ["op-1", "op-2", "op-3", "op-4", "op-5", "op-6", "op-7"]) expect(html).toContain(`data-testid="diff-${id}"`);
  });

  it("each item has Use (the include box), its own Edit, and the source behind a disclosure", () => {
    const html = render();
    expect(input(html, 'type="checkbox"', 'checked=""', 'aria-label="Include op-3"')).toBe(true);
    expect(part(html, "diff-op-3")).toContain("Use");
    expect(html).toMatch(/<button[^>]*data-testid="edit-op-3"[^>]*>Edit<\/button>/);
    expect(html).toMatch(/<details[^>]*data-testid="source-op-3"/);
    expect(part(html, "source-op-3")).toContain("Source: Pasted text · confidence 1.00");
    expect(part(html, "source-op-3")).toContain("advisory only");
    expect(part(html, "source-op-3")).toContain("Actor: Building manager — Owns the lobby.");
  });

  it("a rejected item says so and keeps its box unchecked", () => {
    const html = render({ excluded: new Set(["op-5"]) });
    expect(input(html, 'type="checkbox"', 'aria-label="Include op-5"')).toBe(true);
    expect(input(html, 'checked=""', 'aria-label="Include op-5"')).toBe(false);
    expect(html).toMatch(/data-testid="diff-op-5"[^>]*data-state="rejected"/);
    expect(part(html, "diff-op-5")).toContain("Rejected");
    expect(html).toMatch(/data-testid="diff-op-3"[^>]*data-state="used"/);
  });

  it("two goals are a choice: radios, none chosen, and the words that nobody chooses for the human", () => {
    const html = render({ excluded: new Set(["op-1", "op-7"]) });
    const choice = part(html, "goal-choice");
    expect(choice).toContain("ASM does not choose for you");
    expect(input(html, 'type="radio"', 'name="goal-choice"', 'aria-label="Choose op-1"')).toBe(true);
    expect(input(html, 'type="radio"', 'name="goal-choice"', 'aria-label="Choose op-7"')).toBe(true);
    expect(input(html, 'name="goal-choice"', 'checked=""')).toBe(false);
    // The goal ops are not shown a second time as ordinary items with a checkbox.
    expect(html).not.toContain('aria-label="Include op-1"');
    expect(html).not.toContain('aria-label="Include op-7"');
  });

  it("a chosen goal is the checked radio; the other stays unchecked", () => {
    const html = render({ excluded: new Set(["op-7"]) });
    expect(input(html, 'aria-label="Choose op-1"', 'checked=""')).toBe(true);
    expect(input(html, 'aria-label="Choose op-7"', 'checked=""')).toBe(false);
  });

  it("editing an item shows its fields with suggestion chips; a chip is a button that fills, nothing more", () => {
    const html = render({ editing: new Set(["op-4"]), excluded: new Set(["op-7"]) });
    expect(html).toMatch(/<textarea name="op-4-statement"/);
    expect(html).toMatch(/<button type="button" class="chip"[^>]*data-testid="chip-op-4-statement-0"[^>]*>As written: Need \(Resident\): Get my parcel on the day it arrives\.<\/button>/);
    // The goal being edited offers the alternative as a chip too.
    const goal = render({ editing: new Set(["op-1"]), excluded: new Set(["op-7"]) });
    expect(goal).toContain('data-testid="chip-op-1-statement-1"');
    expect(part(goal, "chip-op-1-statement-1")).toBe("Alternative: Couriers deliver to the building in one stop.");
    // Items not being edited show no textarea and no chip.
    expect(html).not.toMatch(/<textarea name="op-3-/);
    expect(html).not.toContain('data-testid="chip-op-3');
  });

  it("a rejected item never opens its fields, even under Edit all", () => {
    // Found by the independent verifier on 1d44fc9: editing a rejected item was unobserved.
    const html = render({ editing: new Set(["op-1", "op-2", "op-3", "op-4", "op-5", "op-6"]), excluded: new Set(["op-5", "op-7"]) });
    expect(html).not.toMatch(/<textarea name="op-5-/);
    expect(html).not.toContain('data-testid="chip-op-5');
    expect(html).not.toContain('data-testid="edit-op-5"');
    expect(html).toMatch(/<textarea name="op-4-statement"/);
    expect(part(html, "diff-op-5")).toContain("Rejected");
  });
});
