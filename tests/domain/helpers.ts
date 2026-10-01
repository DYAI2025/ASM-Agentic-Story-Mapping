import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProductDocument } from "../../src/domain/schema";
import { parseProductText } from "../../src/domain/serialize";

export const FIXTURE_PATH = path.join(__dirname, "..", "..", "product", "asm.product.yaml");

export function fixtureText(): string {
  return readFileSync(FIXTURE_PATH, "utf8");
}

export function loadFixture(): ProductDocument {
  const result = parseProductText(fixtureText());
  if (!result.ok) throw new Error(`fixture is invalid: ${JSON.stringify(result.issues)}`);
  return result.product;
}

/** A deep, mutable copy for building invalid variants. */
export function mutableFixture(): ProductDocument {
  return structuredClone(loadFixture());
}
