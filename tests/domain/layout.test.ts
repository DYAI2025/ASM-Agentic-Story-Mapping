import { describe, expect, it } from "vitest";
import {
  DomainError,
  approveRevision,
  moveStep,
  semanticsOf,
  setCardRow,
  updateCard,
} from "../../src/domain/operations";
import { buildStoryMap } from "../../src/domain/projection";
import type { ProductDocument } from "../../src/domain/schema";
import { loadFixture } from "./helpers";

function allIds(p: ProductDocument): string[] {
  return [
    p.product.id,
    p.goal.id,
    ...p.personas.map((e) => e.id),
    ...p.needs.map((e) => e.id),
    ...p.narrative.map((e) => e.id),
    ...p.wcbc.map((e) => e.id),
    ...p.decisions.map((e) => e.id),
  ].sort();
}

describe("visual position is not the source of semantics", () => {
  it("moving a card visually leaves every semantic field untouched", () => {
    const before = loadFixture();
    let after = before;
    for (const step of before.narrative) after = setCardRow(after, step.id, 2);

    expect(after.layout).not.toEqual(before.layout);
    expect(semanticsOf(after)).toEqual(semanticsOf(before));
    expect(allIds(after)).toEqual(allIds(before));
  });

  it("visual position does not change the projected narrative order or branches", () => {
    const before = loadFixture();
    const after = setCardRow(setCardRow(before, "step-export-work", 2), "step-start-product", 1);
    const shape = (p: ProductDocument) =>
      buildStoryMap(p, null).columns.map((c) => [c.step.id, c.branches.map((b) => b.id)]);
    expect(shape(after)).toEqual(shape(before));
  });

  it("a visual move does not reopen an approved revision", () => {
    const approved = approveRevision(loadFixture(), {
      approvedBy: "Ada",
      approvedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(setCardRow(approved, "step-main-path", 1).revision).toEqual(approved.revision);
  });

  it("resetting to row 0 removes the layout entry", () => {
    const moved = setCardRow(loadFixture(), "step-main-path", 2);
    expect(setCardRow(moved, "step-main-path", 0).layout).toEqual({ cards: {} });
  });

  it("rejects layout for unknown cards and out-of-range rows", () => {
    expect(() => setCardRow(loadFixture(), "step-ghost", 1)).toThrow(DomainError);
    expect(() => setCardRow(loadFixture(), "step-main-path", 7)).toThrow(DomainError);
  });
});

describe("semantic edits keep ids and relations intact", () => {
  it("reordering the narrative swaps sequences only", () => {
    const before = loadFixture();
    const after = moveStep(before, "step-describe-idea", 1);

    expect(buildStoryMap(after, null).columns.slice(1, 3).map((c) => c.step.id)).toEqual([
      "step-confirm-intent",
      "step-describe-idea",
    ]);
    expect(allIds(after)).toEqual(allIds(before));
    expect(after.wcbc).toEqual(before.wcbc);
    const strip = (p: ProductDocument) => p.narrative.map(({ sequence: _s, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
  });

  it("cannot move past either end of the narrative", () => {
    expect(() => moveStep(loadFixture(), "step-start-product", -1)).toThrow(DomainError);
    expect(() => moveStep(loadFixture(), "step-export-work", 1)).toThrow(DomainError);
  });

  it("editing card text changes only that text", () => {
    const before = loadFixture();
    const after = updateCard(before, "wcbc-vague-discussion", { title: "Input is unclear" });
    expect(after.wcbc.find((b) => b.id === "wcbc-vague-discussion")).toEqual({
      ...before.wcbc.find((b) => b.id === "wcbc-vague-discussion"),
      title: "Input is unclear",
    });
    expect(allIds(after)).toEqual(allIds(before));
  });

  it("ids and relations are not editable through card edits", () => {
    const product = loadFixture();
    expect(() => updateCard(product, "step-start-product", { id: "renamed" })).toThrow(DomainError);
    expect(() => updateCard(product, "wcbc-vague-discussion", { stepId: "step-export-work" })).toThrow(
      DomainError,
    );
    expect(() => updateCard(product, "need-see-gaps", { personaId: "persona-developer" })).toThrow(
      DomainError,
    );
  });

  it("rejects an edit that would empty a required text", () => {
    expect(() => updateCard(loadFixture(), "step-start-product", { title: "  " })).toThrow(DomainError);
  });
});
