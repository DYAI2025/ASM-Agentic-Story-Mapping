import { slugify } from "./ids";
import { applyMapPatch } from "./map-patch";
import { SCHEMA_VERSION, type ProductDocument } from "./schema";
import { validateProduct, type ValidationIssue } from "./validate";

/**
 * Starting a product from nothing.
 *
 * There is no second way to build a map. A first product is the ordinary
 * proposal mechanism (`resolveProposal`, `applyMapPatch`) run against a blank
 * draft: a document with a name and nothing else. The blank draft is not a
 * product. It has no goal, does not validate and is never saved; only what a
 * human accepts on top of it can become revision 1.
 */

export const MAX_NAME_LENGTH = 120;

export type BlankResult = { ok: true; product: ProductDocument } | { ok: false; issues: ValidationIssue[] };
export type BootstrapResult = { ok: true; product: ProductDocument } | { ok: false; issues: ValidationIssue[] };

/** The draft a first proposal is built against. Deterministic: the same name always gives the same draft. */
export function blankProduct(nameInput: string): BlankResult {
  const name = nameInput.trim();
  // One line of ordinary text: no line breaks or other control characters.
  if (name === "" || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name))
    return {
      ok: false,
      issues: [{ code: "invalid_name", path: "name", message: `give the product a name: one line of at most ${MAX_NAME_LENGTH} characters` }],
    };
  const slug = slugify(name);
  return {
    ok: true,
    product: {
      schemaVersion: SCHEMA_VERSION,
      // An id has to start with a letter.
      product: { id: /^[a-z]/.test(slug) ? slug : `product-${slug}`, name, summary: name },
      // Revision 0 does not exist as a product; accepting a proposal makes it revision 1.
      revision: { number: 0, status: "proposed" },
      goal: { id: `goal-${slug}`, statement: "" },
      personas: [],
      needs: [],
      narrative: [],
      wcbc: [],
      decisions: [],
      provenance: [],
      layout: { cards: {} },
    },
  };
}

export const GOAL_REQUIRED: ValidationIssue = {
  code: "goal_required",
  path: "goal",
  message:
    "The text does not say what the product is for. Add one sentence that does, and structure it again. Nothing was created.",
};

/** Whether a refusal came from the draft still having no goal: the statement is empty, not merely unacceptable. */
export function lacksGoal(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => issue.path === "goal.statement" && issue.code === "schema_too_small");
}

/**
 * The human accepted a proposal for a first map: the blank draft plus that
 * proposal, as revision 1, proposed. Pure; the caller decides whether to
 * create the file. The summary line is the goal the human accepted.
 */
export function bootstrapProduct(name: string, patch: unknown): BootstrapResult {
  const blank = blankProduct(name);
  if (!blank.ok) return blank;
  const applied = applyMapPatch(blank.product, patch);
  if (!applied.ok) return lacksGoal(applied.issues) ? { ok: false, issues: [GOAL_REQUIRED] } : applied;
  const validated = validateProduct({
    ...applied.product,
    product: { ...applied.product.product, summary: applied.product.goal.statement },
  });
  if (!validated.ok) return validated;
  return { ok: true, product: validated.product };
}
