import { ValueChainRoleSchema, type ProductDocument } from "./schema";

/** Fixed key and element order so that exports are stable and diffable. */
export function canonicalize(p: ProductDocument): ProductDocument {
  const layoutCards: ProductDocument["layout"]["cards"] = {};
  for (const id of Object.keys(p.layout.cards).sort()) {
    layoutCards[id] = { row: p.layout.cards[id].row };
  }
  const outcome = (o: NonNullable<ProductDocument["wcbc"][number]["outcome"]>) => {
    if (o.kind === "recovery") return { kind: o.kind, resumeStepId: o.resumeStepId };
    if (o.kind === "escalation") return { kind: o.kind, toPersonaId: o.toPersonaId };
    return { kind: o.kind };
  };
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
    // The optional fields appear only when the map states them, so a map that never did keeps its fingerprint.
    personas: p.personas.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      // In the fixed order of the role list: the order roles are written in carries no meaning.
      ...(e.roles ? { roles: ValueChainRoleSchema.options.filter((role) => e.roles!.includes(role)) } : {}),
      ...(e.persona !== undefined ? { persona: e.persona } : {}),
    })),
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
      ...(e.outcome ? { outcome: outcome(e.outcome) } : {}),
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

/** FNV-1a over a string, as eight hex digits. Not a security feature. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Short, deterministic fingerprint of a document's meaning. Layout is
 * excluded: it does not change what the map says.
 * Used to detect that a proposal, a review or a slice selection was built
 * against a map that has since changed. Not a security feature.
 */
export function fingerprint(p: ProductDocument): string {
  const { layout: _layout, ...semantics } = canonicalize(p);
  return hashText(JSON.stringify(semantics));
}
