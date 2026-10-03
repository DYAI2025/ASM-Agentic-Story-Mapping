import { providerFromEnv } from "../../../agent/narrative-builder";
import { ProviderError, type ReviewProvider } from "../../../agent/provider";
import { buildReview } from "../../../agent/reviewer";
import { reviewNarrative } from "../../../domain/review";
import { loadProduct, loadFailureStatus } from "../../../server/store";

export const dynamic = "force-dynamic";

/**
 * Review the canonical narrative. Reads the file and never writes it: the
 * findings only exist in the response. An agent finding reaches the map only
 * if a human accepts it through /api/proposal/accept.
 */
export async function POST() {
  let provider: ReviewProvider;
  try {
    provider = providerFromEnv();
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return Response.json(
      { issues: [{ code: "provider_not_configured", path: "ASM_AGENT_PROVIDER", message: error.message }] },
      { status: 500 },
    );
  }

  const stored = await loadProduct();
  if (!stored.ok) return Response.json({ issues: stored.issues }, { status: loadFailureStatus(stored.issues) });

  const deterministic = reviewNarrative(stored.product);
  const agent = await buildReview(stored.product, provider);
  if (!agent.ok) {
    const providerFailed = agent.issues.some((issue) => issue.code === "provider_error");
    return Response.json(
      { deterministic, issues: agent.issues, provider: provider.name },
      { status: providerFailed ? 502 : 422 },
    );
  }
  return Response.json({ deterministic, review: agent.review, provider: provider.name });
}
