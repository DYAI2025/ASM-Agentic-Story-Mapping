import { ProductDocumentSchema, type ProductDocument } from "./schema";

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; product: ProductDocument; issues: [] }
  | { ok: false; issues: ValidationIssue[] };

function sortIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return [...issues].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
}

/** Every entity that owns an id, with the path it lives at. */
function listIds(p: ProductDocument): { id: string; path: string }[] {
  return [
    { id: p.product.id, path: "product.id" },
    { id: p.goal.id, path: "goal.id" },
    ...p.personas.map((e, i) => ({ id: e.id, path: `personas[${i}].id` })),
    ...p.needs.map((e, i) => ({ id: e.id, path: `needs[${i}].id` })),
    ...p.narrative.map((e, i) => ({ id: e.id, path: `narrative[${i}].id` })),
    ...p.wcbc.map((e, i) => ({ id: e.id, path: `wcbc[${i}].id` })),
    ...p.decisions.map((e, i) => ({ id: e.id, path: `decisions[${i}].id` })),
  ];
}

function checkSemantics(p: ProductDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string, message: string) =>
    issues.push({ code, path, message });

  const seen = new Map<string, string>();
  for (const { id, path } of listIds(p)) {
    const first = seen.get(id);
    if (first) add("duplicate_id", path, `id "${id}" is already used at ${first}`);
    else seen.set(id, path);
  }

  const personaIds = new Set(p.personas.map((e) => e.id));
  const needIds = new Set(p.needs.map((e) => e.id));
  const stepIds = new Set(p.narrative.map((e) => e.id));

  p.needs.forEach((need, i) => {
    if (!personaIds.has(need.personaId))
      add("unknown_persona", `needs[${i}].personaId`, `persona "${need.personaId}" does not exist`);
  });

  p.narrative.forEach((step, i) => {
    step.personaIds.forEach((id, j) => {
      if (!personaIds.has(id))
        add("unknown_persona", `narrative[${i}].personaIds[${j}]`, `persona "${id}" does not exist`);
    });
    step.needIds.forEach((id, j) => {
      if (!needIds.has(id))
        add("unknown_need", `narrative[${i}].needIds[${j}]`, `need "${id}" does not exist`);
    });
  });

  // The main narrative is a gapless sequence 1..n, independent of array order.
  const sequences = p.narrative.map((s) => s.sequence).sort((a, b) => a - b);
  const gapless = sequences.every((value, i) => value === i + 1);
  if (!gapless)
    add(
      "invalid_sequence",
      "narrative",
      `step sequences must be exactly 1..${p.narrative.length} without gaps or duplicates`,
    );

  p.wcbc.forEach((branch, i) => {
    if (!stepIds.has(branch.stepId))
      add("unknown_step", `wcbc[${i}].stepId`, `narrative step "${branch.stepId}" does not exist`);
  });

  p.decisions.forEach((decision, i) => {
    decision.relatesTo.forEach((id, j) => {
      if (!seen.has(id))
        add("unknown_reference", `decisions[${i}].relatesTo[${j}]`, `"${id}" does not exist`);
    });
    if (decision.status === "decided" && decision.rationale.trim() === "")
      add("missing_rationale", `decisions[${i}].rationale`, "a decided decision needs a rationale");
  });

  p.provenance.forEach((entry, i) => {
    if (!seen.has(entry.targetId))
      add("unknown_provenance_target", `provenance[${i}].targetId`, `"${entry.targetId}" does not exist`);
  });

  for (const id of Object.keys(p.layout.cards)) {
    if (!seen.has(id))
      add("unknown_layout_target", `layout.cards.${id}`, `"${id}" does not exist`);
  }

  const { status, approval } = p.revision;
  if (status === "approved" && !approval)
    add("approval_missing", "revision.approval", "an approved revision must record who approved it and when");
  if (status === "proposed" && approval)
    add("approval_unexpected", "revision.approval", "a proposed revision must not carry an approval record");

  return issues;
}

/**
 * Deterministic validation: the same input always yields the same issues in
 * the same order. Shape errors are reported first and stop reference checks.
 */
export function validateProduct(input: unknown): ValidationResult {
  const parsed = ProductDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: sortIssues(
        parsed.error.issues.map((issue) => ({
          code: `schema_${issue.code}`,
          path: issue.path.map(String).join(".") || "(root)",
          message: issue.message,
        })),
      ),
    };
  }
  const issues = checkSemantics(parsed.data);
  if (issues.length > 0) return { ok: false, issues: sortIssues(issues) };
  return { ok: true, product: parsed.data, issues: [] };
}
