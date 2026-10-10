import { z } from "zod";
import type { ValidationIssue } from "./validate";

/**
 * What a proposal is built from: a bundle of text sources, each with a
 * transient identity. The bundle is input state, never part of the product;
 * only the id and label of a source survive, as provenance of what a human
 * accepted. A plain pasted transcript is the one-source case.
 *
 * Text only: pasted text, `.txt` and `.md` files. Nothing here reads a file
 * system or a URL; the browser hands over the text it decoded.
 */

/** Total characters across all sources, and per source: the limit a provider request can carry. */
export const MAX_CONTEXT_CHARS = 60_000;
export const MAX_CONTEXT_SOURCES = 8;
export const MAX_LABEL_LENGTH = 200;
export const SUPPORTED_FILE_EXTENSIONS = [".txt", ".md"] as const;

export const SourceIdSchema = z.string().regex(/^src-\d+$/, "a source id looks like src-1");

export const ContextSourceSchema = z.strictObject({
  id: SourceIdSchema,
  /** Shown to the human: "Pasted text" or the file name. */
  label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  kind: z.enum(["pasted", "file"]),
  text: z.string(),
});

export const ContextBundleSchema = z.strictObject({
  sources: z.array(ContextSourceSchema),
});

export type ContextSource = z.infer<typeof ContextSourceSchema>;
export type ContextBundle = z.infer<typeof ContextBundleSchema>;

export type ContextResult = { ok: true; bundle: ContextBundle } | { ok: false; issues: ValidationIssue[] };

export const PASTED_LABEL = "Pasted text";

/** The one-source bundle a pasted transcript is. Callers that only have a string use this. */
export function bundleFromTranscript(transcript: string): ContextBundle {
  return { sources: [{ id: "src-1", label: PASTED_LABEL, kind: "pasted", text: transcript }] };
}

/** Whether a file name is one of the text types this slice supports. */
export function supportedFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Shape, limits and types. Text content is not interpreted here: that is the
 * provider's job, and whatever it says is validated again in `resolveProposal`.
 */
export function validateContextBundle(input: unknown): ContextResult {
  const parsed = ContextBundleSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: `context_${issue.code}`,
        path: issue.path.map(String).join(".") || "(root)",
        message: issue.message,
      })),
    };
  const bundle = parsed.data;
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });

  if (bundle.sources.length === 0) add("empty_context", "sources", "paste some text or add a text file first");
  if (bundle.sources.length > MAX_CONTEXT_SOURCES)
    add("too_many_sources", "sources", `at most ${MAX_CONTEXT_SOURCES} sources at a time`);
  if (issues.length > 0) return { ok: false, issues };

  const seen = new Set<string>();
  let total = 0;
  bundle.sources.forEach((source, i) => {
    const path = `sources[${i}]`;
    if (seen.has(source.id)) add("duplicate_source_id", `${path}.id`, `source id "${source.id}" is used twice`);
    seen.add(source.id);
    if (source.kind === "file" && !supportedFileName(source.label))
      add("unsupported_type", `${path}.label`, `"${source.label}" is not a .txt or .md file; only text and markdown files are read`);
    if (source.text.trim() === "") add("empty_source", `${path}.text`, `"${source.label}" has no text in it`);
    if (source.text.includes("\u0000")) add("binary_content", `${path}.text`, `"${source.label}" is not a text file`);
    if (source.text.length > MAX_CONTEXT_CHARS)
      add("source_too_large", `${path}.text`, `"${source.label}" has ${source.text.length} characters; the limit is ${MAX_CONTEXT_CHARS} per source`);
    total += source.text.length;
  });
  if (issues.length === 0 && total > MAX_CONTEXT_CHARS)
    add(
      "context_too_large",
      "sources",
      `the sources together have ${total} characters; the limit is ${MAX_CONTEXT_CHARS}. Leave some out and structure them one after another.`,
    );

  return issues.length > 0 ? { ok: false, issues } : { ok: true, bundle };
}

/**
 * The context in a request body: `{ context: { sources } }`, or the older
 * `{ transcript: string }`, which is one pasted source. Anything else is not
 * a request. Shape only; `validateContextBundle` judges the content.
 */
export function contextFromBody(body: unknown): ContextBundle | null {
  if (typeof body !== "object" || body === null) return null;
  const { context, transcript } = body as { context?: unknown; transcript?: unknown };
  if (context !== undefined) {
    const parsed = ContextBundleSchema.safeParse(context);
    return parsed.success ? parsed.data : { sources: [] };
  }
  if (typeof transcript === "string") return bundleFromTranscript(transcript);
  return null;
}

/** How much a bundle holds, for the human to see before sending. */
export function contextSize(bundle: ContextBundle): number {
  return bundle.sources.reduce((sum, source) => sum + source.text.length, 0);
}
