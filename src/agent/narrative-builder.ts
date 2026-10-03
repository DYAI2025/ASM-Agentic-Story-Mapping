import { GOAL_REQUIRED, blankProduct, lacksGoal } from "../domain/bootstrap";
import { MAX_CONTEXT_CHARS, bundleFromTranscript, validateContextBundle, type ContextBundle } from "../domain/context";
import { resolveProposal, type ProposalResult } from "../domain/map-patch";
import type { ProductDocument } from "../domain/schema";
import { AnthropicProvider } from "./anthropic-provider";
import { FakeProvider } from "./fake-provider";
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

/**
 * Provider selection from the environment. The fake is the default so the app
 * works without any credentials. An unknown name is an error, not a fallback.
 *
 *   ASM_AGENT_PROVIDER=fake | anthropic
 *   ASM_AGENT_MODEL=<model id>        (anthropic only, optional)
 */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): AgentProvider & ReviewProvider {
  const name = (env.ASM_AGENT_PROVIDER ?? "fake").trim().toLowerCase();
  if (name === "fake") return new FakeProvider();
  if (name === "anthropic") return new AnthropicProvider({ model: env.ASM_AGENT_MODEL?.trim() || undefined });
  throw new ProviderError(`unknown ASM_AGENT_PROVIDER "${name}"; use "fake" or "anthropic"`);
}
