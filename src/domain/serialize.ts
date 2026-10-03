import YAML from "yaml";
import { canonicalize, fingerprint } from "./fingerprint";
import type { ProductDocument } from "./schema";
import { validateProduct, type ValidationResult } from "./validate";

export { canonicalize, fingerprint };

/**
 * Parse a canonical product file. YAML is a superset of JSON, so one parser
 * covers both formats.
 */
export function parseProductText(text: string): ValidationResult {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "parse_error",
          path: "(root)",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  return validateProduct(raw);
}

export function exportProductYaml(p: ProductDocument): string {
  return YAML.stringify(canonicalize(p), { lineWidth: 0 });
}

export function exportProductJson(p: ProductDocument): string {
  return `${JSON.stringify(canonicalize(p), null, 2)}\n`;
}
