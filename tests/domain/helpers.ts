import { readFileSync } from "node:fs";
import path from "node:path";
import { fingerprint } from "../../src/domain/fingerprint";
import type { ProductDocument } from "../../src/domain/schema";
import { confirmPersonaCheck, type PersonaCheck } from "../../src/domain/work-state";
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

/** The people check for an approved document, as a human would have made it just before selecting. */
export function peopleCheck(p: ProductDocument): PersonaCheck {
  return confirmPersonaCheck(p, { confirmedBy: "Maya", confirmedAt: "2026-10-02T08:30:00.000Z", mapFingerprint: fingerprint(p) });
}
