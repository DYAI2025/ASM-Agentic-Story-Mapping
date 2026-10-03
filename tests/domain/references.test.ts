import { describe, expect, it } from "vitest";
import type { ProductDocument } from "../../src/domain/schema";
import { validateProduct } from "../../src/domain/validate";
import { mutableFixture } from "./helpers";

function issueCodes(mutate: (p: ProductDocument) => void): string[] {
  const product = mutableFixture();
  mutate(product);
  const result = validateProduct(product);
  expect(result.ok).toBe(false);
  return result.issues.map((issue) => `${issue.code}@${issue.path}`);
}

describe("invalid references are rejected", () => {
  it("need pointing at a missing persona", () => {
    expect(issueCodes((p) => (p.needs[0].personaId = "persona-ghost"))).toEqual([
      "unknown_persona@needs[0].personaId",
    ]);
  });

  it("narrative step pointing at a missing persona", () => {
    expect(issueCodes((p) => p.narrative[0].personaIds.push("persona-ghost"))).toEqual([
      "unknown_persona@narrative[0].personaIds[1]",
    ]);
  });

  it("narrative step pointing at a missing need", () => {
    expect(issueCodes((p) => (p.narrative[2].needIds = ["need-ghost"]))).toEqual([
      "unknown_need@narrative[2].needIds[0]",
    ]);
  });

  it("WCBC branch pointing at a missing step", () => {
    expect(issueCodes((p) => (p.wcbc[0].stepId = "step-ghost"))).toEqual([
      "unknown_step@wcbc[0].stepId",
    ]);
  });

  it("decision relating to a missing element", () => {
    expect(issueCodes((p) => (p.decisions[0].relatesTo = ["nothing-here"]))).toEqual([
      "unknown_reference@decisions[0].relatesTo[0]",
    ]);
  });

  it("layout entry for a missing card", () => {
    expect(issueCodes((p) => (p.layout.cards["step-ghost"] = { row: 1 }))).toEqual([
      "unknown_layout_target@layout.cards.step-ghost",
    ]);
  });

  it("removing a referenced persona breaks every reference to it", () => {
    const codes = issueCodes((p) => (p.personas = p.personas.filter((x) => x.id !== "persona-developer")));
    expect(codes.length).toBeGreaterThan(2);
    expect(codes.every((c) => c.startsWith("unknown_persona@"))).toBe(true);
  });
});

describe("other structural rules", () => {
  it("rejects duplicate ids", () => {
    expect(issueCodes((p) => (p.wcbc[1].id = p.narrative[0].id))).toEqual(["duplicate_id@wcbc[1].id"]);
  });

  it("rejects a narrative sequence with gaps or duplicates", () => {
    expect(issueCodes((p) => (p.narrative[3].sequence = 9))).toEqual(["invalid_sequence@narrative"]);
  });

  it("rejects unknown fields instead of silently dropping them", () => {
    const product = mutableFixture() as unknown as Record<string, unknown>;
    product.somethingElse = true;
    expect(validateProduct(product).ok).toBe(false);
  });

  it("rejects malformed ids", () => {
    expect(issueCodes((p) => (p.narrative[0].id = "Step One")).length).toBeGreaterThan(0);
  });

  it("rejects a decided decision without rationale", () => {
    expect(
      issueCodes((p) => {
        p.decisions[0].status = "decided";
        p.decisions[0].rationale = " ";
      }),
    ).toEqual(["missing_rationale@decisions[0].rationale"]);
  });
});
