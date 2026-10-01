/**
 * Project id convention: `<prefix>-<kebab-slug-of-the-name>`.
 * Ids are derived from text, never chosen freely by an agent.
 */
export const ID_PREFIX = {
  persona: "persona",
  need: "need",
  step: "step",
  decision: "dec",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

const MAX_SLUG_LENGTH = 40;

export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "item";
}

/**
 * Deterministic: the same text against the same set of taken ids always
 * yields the same id. A collision gets the suffix -2, -3, ...
 * The new id is added to `taken`.
 */
export function makeId(kind: IdKind, text: string, taken: Set<string>): string {
  const base = `${ID_PREFIX[kind]}-${slugify(text)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

export function hasPrefix(kind: IdKind, id: string): boolean {
  return id.startsWith(`${ID_PREFIX[kind]}-`);
}
