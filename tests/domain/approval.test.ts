import { describe, expect, it } from "vitest";
import {
  DomainError,
  approveRevision,
  moveStep,
  setCardRow,
  updateCard,
} from "../../src/domain/operations";
import { validateProduct } from "../../src/domain/validate";
import { loadFixture, mutableFixture } from "./helpers";

const APPROVAL = { approvedBy: "Ada Lovelace", approvedAt: "2026-10-01T10:00:00.000Z" };

describe("proposed -> approved is an explicit transition", () => {
  it("approveRevision records who approved and when", () => {
    const approved = approveRevision(loadFixture(), APPROVAL);
    expect(approved.revision).toEqual({ number: 1, status: "approved", approval: APPROVAL });
  });

  it("requires a named human", () => {
    expect(() => approveRevision(loadFixture(), { ...APPROVAL, approvedBy: "   " })).toThrow(DomainError);
  });

  it("cannot approve an already approved revision", () => {
    const approved = approveRevision(loadFixture(), APPROVAL);
    expect(() => approveRevision(approved, APPROVAL)).toThrow(DomainError);
  });

  it("no editing operation ever approves", () => {
    const product = loadFixture();
    const edited = [
      updateCard(product, "step-start-product", { title: "Begin" }),
      moveStep(product, "step-start-product", 1),
      setCardRow(product, "step-start-product", 1),
    ];
    for (const result of edited) expect(result.revision).toEqual({ number: 1, status: "proposed" });
  });

  it("a status flipped by hand without an approval record is invalid", () => {
    const product = mutableFixture();
    product.revision.status = "approved";
    const result = validateProduct(product);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual(["approval_missing"]);
  });

  it("a proposed revision carrying an approval record is invalid", () => {
    const product = mutableFixture();
    product.revision.approval = APPROVAL;
    const result = validateProduct(product);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual(["approval_unexpected"]);
  });

  it("a semantic edit to an approved revision opens a new proposed revision", () => {
    const approved = approveRevision(loadFixture(), APPROVAL);
    expect(updateCard(approved, "goal-faster-shared-narrative", { statement: "New goal" }).revision).toEqual({
      number: 2,
      status: "proposed",
    });
    expect(moveStep(approved, "step-start-product", 1).revision).toEqual({ number: 2, status: "proposed" });
  });
});
