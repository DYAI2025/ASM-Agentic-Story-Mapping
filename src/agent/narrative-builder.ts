import { resolveProposal, type ProposalResult } from "../domain/map-patch";
import type { ProductDocument } from "../domain/schema";
import { AnthropicProvider } from "./anthropic-provider";
import { FakeProvider } from "./fake-provider";
import { ProviderError, type AgentProvider } from "./provider";

export const MAX_TRANSCRIPT_CHARS = 60_000;

/**
 * Discussion text -> validated proposal. Reads the map, writes nothing.
 * Whatever the provider returns goes through `resolveProposal`; a provider
 * failure or an invalid answer yields issues, never a partial proposal.
 */
export async function buildProposal(
  product: ProductDocument,
  transcript: string,
  provider: AgentProvider,
): Promise<ProposalResult> {
  if (transcript.trim() === "")
    return { ok: false, issues: [{ code: "empty_transcript", path: "transcript", message: "paste some discussion text first" }] };
  if (transcript.length > MAX_TRANSCRIPT_CHARS)
    return {
      ok: false,
      issues: [
        {
          code: "transcript_too_long",
          path: "transcript",
          message: `the text has ${transcript.length} characters; the limit is ${MAX_TRANSCRIPT_CHARS}. Split it and structure the parts one after another.`,
        },
      ],
    };

  let raw: unknown;
  try {
    raw = await provider.structure({ transcript, product });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { ok: false, issues: [{ code: "provider_error", path: provider.name, message: error.message }] };
  }
  return resolveProposal(product, raw, transcript, provider.name);
}

/**
 * Provider selection from the environment. The fake is the default so the app
 * works without any credentials. An unknown name is an error, not a fallback.
 *
 *   ASM_AGENT_PROVIDER=fake | anthropic
 *   ASM_AGENT_MODEL=<model id>        (anthropic only, optional)
 */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): AgentProvider {
  const name = (env.ASM_AGENT_PROVIDER ?? "fake").trim().toLowerCase();
  if (name === "fake") return new FakeProvider();
  if (name === "anthropic") return new AnthropicProvider({ model: env.ASM_AGENT_MODEL?.trim() || undefined });
  throw new ProviderError(`unknown ASM_AGENT_PROVIDER "${name}"; use "fake" or "anthropic"`);
}
