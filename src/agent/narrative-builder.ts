import { GOAL_REQUIRED, blankProduct, lacksGoal } from "../domain/bootstrap";
import { MAX_CONTEXT_CHARS, bundleFromTranscript, validateContextBundle, type ContextBundle } from "../domain/context";
import { resolveProposal, type ProposalResult } from "../domain/map-patch";
import type { ProductDocument } from "../domain/schema";
import { AnthropicProvider } from "./anthropic-provider";
import { FakeProvider } from "./fake-provider";
import { OpenAIProvider } from "./openai-provider";
import { OpenRouterProvider } from "./openrouter-provider";
import { ProviderError, type AgentProvider, type ReviewProvider } from "./provider";

/** The same limit as the context bundle's; kept under its old name for callers that think in one transcript. */
export const MAX_TRANSCRIPT_CHARS = MAX_CONTEXT_CHARS;

/**
 * Context -> validated proposal. Reads the map, writes nothing. The context
 * is a bundle of sources, or one pasted string; it is validated before any
 * provider sees it. Whatever the provider returns goes through
 * `resolveProposal`; a provider failure or an invalid answer yields issues,
 * never a partial proposal.
 */
export async function buildProposal(
  product: ProductDocument,
  context: string | ContextBundle,
  provider: AgentProvider,
): Promise<ProposalResult> {
  const validated = validateContextBundle(typeof context === "string" ? bundleFromTranscript(context) : context);
  if (!validated.ok) return validated;
  const bundle = validated.bundle;

  let raw: unknown;
  try {
    raw = await provider.structure({ context: bundle, product });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { ok: false, issues: [{ code: "provider_error", path: provider.name, message: error.message }] };
  }
  return resolveProposal(product, raw, bundle, provider.name);
}

/**
 * A first product: the same builder, against the blank draft for that name.
 * A proposal that would leave the product without a goal is not shown as one.
 */
export async function startProposal(name: string, context: string | ContextBundle, provider: AgentProvider): Promise<ProposalResult> {
  const blank = blankProduct(name);
  if (!blank.ok) return blank;
  const result = await buildProposal(blank.product, context, provider);
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
  if (name === "anthropic") return new AnthropicProvider({ model, timeoutMs });
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
