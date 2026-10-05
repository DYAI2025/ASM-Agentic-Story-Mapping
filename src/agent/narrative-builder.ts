import { GOAL_REQUIRED, blankProduct, lacksGoal } from "../domain/bootstrap";
import { MAX_CONTEXT_CHARS, bundleFromTranscript, validateContextBundle, type ContextBundle } from "../domain/context";
import { resolveProposal, type ProposalResult } from "../domain/map-patch";
import type { ProductDocument } from "../domain/schema";
import type { ValidationIssue } from "../domain/validate";
import { AnthropicProvider } from "./anthropic-provider";
import { FakeProvider } from "./fake-provider";
import { redactSecrets } from "./http";
import { OpenAIProvider } from "./openai-provider";
import { OpenRouterProvider } from "./openrouter-provider";
import { ProviderError, type AgentProvider, type RepairRequest, type ReviewProvider } from "./provider";

/** The same limit as the context bundle's; kept under its old name for callers that think in one transcript. */
export const MAX_TRANSCRIPT_CHARS = MAX_CONTEXT_CHARS;

/** How many model calls one submission made: 1, or 2 when the one repair request was sent. */
export type ProposalTrace = { modelCalls: number };

/**
 * Context -> validated proposal. Reads the map, writes nothing. The context
 * is a bundle of sources, or one pasted string; it is validated before any
 * provider sees it. Whatever the provider returns goes through
 * `resolveProposal`; a provider failure or an invalid answer yields issues,
 * never a partial proposal.
 *
 * One repair, and only one (ASM-29): when an answer parsed but was refused for
 * its shape or for named items in it (a quote not in the source it names, an
 * unknown or missing source, a malformed, duplicated or undeclared ref, an id
 * not on the map, a role outside the list), the provider is asked once more,
 * with the contract and what was refused. That answer is untrusted like the
 * first and goes through `resolveProposal` from scratch; a refused value is
 * never accepted as it was, and nothing here rewrites one. Not repaired: a
 * provider failure (credentials, rate limit, timeout, network, refusal,
 * filter, cut-off, no JSON), any other refusal of the answer (an empty answer,
 * text limits, confidence, placement), and any refusal of the dry run (a
 * proposal the map cannot take). There is no loop, so no submission makes a
 * third call.
 */
export async function buildProposal(
  product: ProductDocument,
  context: string | ContextBundle,
  provider: AgentProvider,
  trace: ProposalTrace = { modelCalls: 0 },
): Promise<ProposalResult> {
  const validated = validateContextBundle(typeof context === "string" ? bundleFromTranscript(context) : context);
  if (!validated.ok) return validated;
  const bundle = validated.bundle;

  const ask = async (repair?: RepairRequest): Promise<{ result: ProposalResult; raw?: unknown }> => {
    trace.modelCalls++;
    let raw: unknown;
    try {
      raw = await provider.structure(repair ? { context: bundle, product, repair } : { context: bundle, product });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      return { result: { ok: false, issues: [{ code: "provider_error", path: provider.name, message: error.message }] } };
    }
    return { result: resolveProposal(product, raw, bundle, provider.name), raw };
  };

  const first = await ask();
  if (first.result.ok || !isRepairable(first.result)) return first.result;
  return (await ask(repairRequest(first.result.issues, first.raw))).result;
}

/**
 * The kinds of named item the PO decided may be named in the one repair
 * (2026-10-06): quotes and their sources, refs and ids, roles. With the
 * output contract refusing the answer's shape (`agent_output_*`), nothing else
 * qualifies.
 */
const REPAIRABLE_ITEM_CODES = new Set([
  // quotes and their sources
  "snippet_not_in_source",
  "unknown_source",
  "source_required",
  // refs and ids
  "invalid_ref",
  "duplicate_ref",
  "unknown_ref",
  "unknown_id",
  // roles
  "unknown_role",
  "duplicate_role",
]);

/** A refusal of the answer itself (no dry-run stage) in which every issue is one of the repairable kinds. */
function isRepairable(result: { issues: readonly ValidationIssue[]; stage?: "apply" }): boolean {
  if (result.stage === "apply") return false;
  return result.issues.length > 0 && result.issues.every((issue) => issue.code.startsWith("agent_output_") || REPAIRABLE_ITEM_CODES.has(issue.code));
}

export const MAX_REPAIR_PROBLEMS = 20;
const MAX_PROBLEM_PATH = 120;
const MAX_PROBLEM_MESSAGE = 240;
const MAX_PROBLEM_VALUE = 160;

const oneLine = (text: string) => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The value at an issue's path in the previous answer (`personas[1].source.snippet`), when it is text. */
function textAt(output: unknown, path: string): string | null {
  let node = output;
  for (const key of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "string" ? node : null;
}

/**
 * The bounded problem summary a repair request carries: a shape problem at
 * every position of an array is one line with a count (`needs.*.persona`); a
 * refused item keeps its position and quotes the value that was refused, so
 * the model can see which quote or ref it was. Each line is clipped and on one
 * line, anything shaped like a key is redacted, and at most
 * MAX_REPAIR_PROBLEMS lines go out, the rest counted.
 */
export function repairRequest(issues: readonly ValidationIssue[], previous?: unknown): RepairRequest {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    // Redacted before clipping, so a key cut at a clip boundary cannot leave a tail the pattern no longer matches.
    const path = clip(redactSecrets(oneLine(issue.path.replace(/\.\d+(?=\.|$)/g, ".*"))), MAX_PROBLEM_PATH);
    const value = issue.code.startsWith("agent_output_") ? null : textAt(previous, issue.path);
    const quoted = value === null ? "" : ` (your value: "${clip(redactSecrets(oneLine(value)), MAX_PROBLEM_VALUE)}")`;
    const line = `${path}: ${clip(redactSecrets(oneLine(issue.message)), MAX_PROBLEM_MESSAGE)}${quoted}`;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const lines = [...counts].map(([line, n]) => redactSecrets(n > 1 ? `${line} (${n} times)` : line));
  return { problems: lines.slice(0, MAX_REPAIR_PROBLEMS), omitted: Math.max(0, lines.length - MAX_REPAIR_PROBLEMS) };
}

/**
 * A first product: the same builder, against the blank draft for that name.
 * A proposal that would leave the product without a goal is not shown as one.
 */
export async function startProposal(
  name: string,
  context: string | ContextBundle,
  provider: AgentProvider,
  trace: ProposalTrace = { modelCalls: 0 },
): Promise<ProposalResult> {
  const blank = blankProduct(name);
  if (!blank.ok) return blank;
  const result = await buildProposal(blank.product, context, provider, trace);
  if (!result.ok && lacksGoal(result.issues)) return { ok: false, issues: [GOAL_REQUIRED] };
  if (!result.ok && result.issues.some((issue) => issue.code === "empty_proposal"))
    return {
      ok: false,
      issues: [
        {
          code: "nothing_structured",
          path: "transcript",
          message:
            provider instanceof FakeProvider
              ? "Nothing in the text could be turned into a map. No language model is connected, so each item needs its own line starting with Goal:, Persona:, Actor:, Need (name): or Step: — see the example above the text field. Nothing was created."
              : "Nothing in the text could be turned into a map. Say what the product is for, who is involved and what they do, then try again. Nothing was created.",
        },
      ],
    };
  return result;
}

export const PROVIDER_NAMES = ["fake", "anthropic", "openai", "openrouter"] as const;

/**
 * Provider selection from the environment. The fake is the default so the app
 * works without any credentials. An unknown name, a missing key or a missing
 * model is an error the route shows, never a fallback to another provider.
 *
 *   ASM_AGENT_PROVIDER=fake | anthropic | openai | openrouter
 *   ASM_AGENT_MODEL=<model id>        optional for anthropic and openai, required for openrouter
 *   ASM_AGENT_TIMEOUT_MS=<ms>         optional, default 120000
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY   server-side only
 */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): AgentProvider & ReviewProvider {
  const name = (env.ASM_AGENT_PROVIDER ?? "fake").trim().toLowerCase();
  const model = env.ASM_AGENT_MODEL?.trim() || undefined;
  const timeoutMs = timeoutFromEnv(env.ASM_AGENT_TIMEOUT_MS);
  if (name === "fake") return new FakeProvider();
  if (name === "anthropic") {
    if (!env.ANTHROPIC_API_KEY)
      throw new ProviderError("ANTHROPIC_API_KEY is not set; the anthropic provider needs it in the server environment");
    return new AnthropicProvider({ model, timeoutMs, apiKey: env.ANTHROPIC_API_KEY, secrets: [env.ANTHROPIC_API_KEY] });
  }
  if (name === "openai") {
    if (!env.OPENAI_API_KEY) throw new ProviderError("OPENAI_API_KEY is not set; the openai provider needs it in the server environment");
    return new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, model, baseUrl: env.OPENAI_BASE_URL?.trim() || undefined, timeoutMs });
  }
  if (name === "openrouter") {
    if (!env.OPENROUTER_API_KEY) throw new ProviderError("OPENROUTER_API_KEY is not set; the openrouter provider needs it in the server environment");
    if (!model) throw new ProviderError("ASM_AGENT_MODEL is not set; OpenRouter needs the model named, e.g. vendor/model");
    return new OpenRouterProvider({ apiKey: env.OPENROUTER_API_KEY, model, timeoutMs });
  }
  throw new ProviderError(`unknown ASM_AGENT_PROVIDER "${name}"; use one of ${PROVIDER_NAMES.join(", ")}`);
}

function timeoutFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 1_000 || ms > 600_000)
    throw new ProviderError(`ASM_AGENT_TIMEOUT_MS must be a whole number of milliseconds between 1000 and 600000, not "${value}"`);
  return ms;
}
