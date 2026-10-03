import { describe, expect, it } from "vitest";
import { buildStoryMap } from "../../src/domain/projection";
import { parseProductText } from "../../src/domain/serialize";
import { validateProduct } from "../../src/domain/validate";
import { fixtureText, loadFixture } from "./helpers";

describe("canonical ASM fixture", () => {
  it("validates without issues", () => {
    const result = parseProductText(fixtureText());
    expect(result).toMatchObject({ ok: true, issues: [] });
  });

  it("is seeded as a proposed revision without an approval record", () => {
    const { revision } = loadFixture();
    expect(revision).toEqual({ number: 1, status: "proposed" });
  });

  it("carries the agreed goal, personas and narrative", () => {
    const product = loadFixture();
    expect(product.goal.statement).toBe(
      "Software teams without prior AI experience can move from product discussion to a shared, understandable product narrative and first useful delivery slice substantially faster.",
    );
    expect(product.personas.map((p) => p.name)).toEqual([
      "Product Lead / Product Owner",
      "Domain or UX Expert",
      "Developer",
    ]);
    expect(buildStoryMap(product, null).columns.map((c) => c.step.title)).toEqual([
      "Start product",
      "Describe idea / provide discussion",
      "Confirm product intent",
      "Define personas and needs",
      "Build main / best-case path",
      "Add relevant WCBC / recovery paths",
      "Review gaps and unresolved decisions",
      "Human approves narrative",
      "Review first slice candidates",
      "Human selects first slice",
      "Export execution-ready work",
    ]);
  });

  it("has WCBC branches and both open and decided decisions", () => {
    const product = loadFixture();
    expect(product.wcbc.length).toBeGreaterThan(0);
    expect(new Set(product.decisions.map((d) => d.status))).toEqual(new Set(["open", "decided"]));
  });

  it("is validated deterministically", () => {
    const broken = { ...loadFixture(), needs: [{ id: "x", personaId: "nope", statement: "s" }] };
    expect(validateProduct(broken)).toEqual(validateProduct(broken));
  });
});
