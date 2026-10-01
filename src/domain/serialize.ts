import YAML from "yaml";
import type { ProductDocument } from "./schema";
import { validateProduct, type ValidationResult } from "./validate";

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

/** Fixed key and element order so that exports are stable and diffable. */
export function canonicalize(p: ProductDocument): ProductDocument {
  const layoutCards: ProductDocument["layout"]["cards"] = {};
  for (const id of Object.keys(p.layout.cards).sort()) {
    layoutCards[id] = { row: p.layout.cards[id].row };
  }
  return {
    schemaVersion: p.schemaVersion,
    product: { id: p.product.id, name: p.product.name, summary: p.product.summary },
    revision: {
      number: p.revision.number,
      status: p.revision.status,
      ...(p.revision.approval
        ? {
            approval: {
              approvedBy: p.revision.approval.approvedBy,
              approvedAt: p.revision.approval.approvedAt,
            },
          }
        : {}),
    },
    goal: { id: p.goal.id, statement: p.goal.statement },
    personas: p.personas.map((e) => ({ id: e.id, name: e.name, description: e.description })),
    needs: p.needs.map((e) => ({ id: e.id, personaId: e.personaId, statement: e.statement })),
    narrative: [...p.narrative]
      .sort((a, b) => a.sequence - b.sequence)
      .map((e) => ({
        id: e.id,
        sequence: e.sequence,
        title: e.title,
        description: e.description,
        personaIds: [...e.personaIds],
        needIds: [...e.needIds],
      })),
    wcbc: p.wcbc.map((e) => ({
      id: e.id,
      stepId: e.stepId,
      kind: e.kind,
      title: e.title,
      description: e.description,
      recovery: e.recovery,
    })),
    decisions: p.decisions.map((e) => ({
      id: e.id,
      title: e.title,
      status: e.status,
      rationale: e.rationale,
      relatesTo: [...e.relatesTo],
    })),
    provenance: p.provenance.map((e) => ({
      targetId: e.targetId,
      change: e.change,
      snippet: e.snippet,
      rationale: e.rationale,
      confidence: e.confidence,
      provider: e.provider,
      revision: e.revision,
    })),
    layout: { cards: layoutCards },
  };
}

/**
 * Short, deterministic fingerprint of a document's meaning (layout excluded).
 * Used to detect that a proposal was built against a map that has since
 * changed. Not a security feature.
 */
export function fingerprint(p: ProductDocument): string {
  const { layout: _layout, ...semantics } = canonicalize(p);
  const text = JSON.stringify(semantics);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function exportProductYaml(p: ProductDocument): string {
  return YAML.stringify(canonicalize(p), { lineWidth: 0 });
}

export function exportProductJson(p: ProductDocument): string {
  return `${JSON.stringify(canonicalize(p), null, 2)}\n`;
}
