import { describe, expect, it } from "vitest";
import { approveRevision, setCardRow } from "../../src/domain/operations";
import {
  canonicalize,
  exportProductJson,
  exportProductYaml,
  parseProductText,
} from "../../src/domain/serialize";
import type { ProductDocument } from "../../src/domain/schema";
import { loadFixture } from "./helpers";

function reimport(text: string): ProductDocument {
  const result = parseProductText(text);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.product;
}

describe("import/export round-trip", () => {
  it("YAML export re-imports to the same semantics", () => {
    const product = loadFixture();
    expect(reimport(exportProductYaml(product))).toEqual(canonicalize(product));
  });

  it("JSON export re-imports to the same semantics", () => {
    const product = loadFixture();
    expect(reimport(exportProductJson(product))).toEqual(canonicalize(product));
  });

  it("YAML -> JSON -> YAML is lossless", () => {
    const product = loadFixture();
    const viaJson = reimport(exportProductJson(reimport(exportProductYaml(product))));
    expect(exportProductYaml(viaJson)).toBe(exportProductYaml(product));
  });

  it("export is byte-stable across repeated round-trips", () => {
    const once = exportProductYaml(loadFixture());
    expect(exportProductYaml(reimport(once))).toBe(once);
  });

  it("preserves approval records and layout", () => {
    const changed = setCardRow(
      approveRevision(loadFixture(), { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" }),
      "step-main-path",
      2,
    );
    const back = reimport(exportProductYaml(changed));
    expect(back.revision).toEqual({
      number: 1,
      status: "approved",
      approval: { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" },
    });
    expect(back.layout).toEqual({ cards: { "step-main-path": { row: 2 } } });
  });

  it("narrative order comes from `sequence`, not from file order", () => {
    const product = loadFixture();
    const shuffled = { ...product, narrative: [...product.narrative].reverse() };
    expect(exportProductYaml(shuffled)).toBe(exportProductYaml(product));
  });

  it("reports unparseable input instead of throwing", () => {
    const result = parseProductText("product: [unclosed");
    expect(result.ok).toBe(false);
    expect(result.issues[0].code).toBe("parse_error");
  });
});
