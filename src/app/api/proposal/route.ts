import { buildProposal, providerFromEnv } from "../../../agent/narrative-builder";
import { ProviderError, type AgentProvider } from "../../../agent/provider";
import { contextFromBody } from "../../../domain/context";
import { loadProduct, loadFailureStatus } from "../../../server/store";
import { crossSiteRefusal } from "../../../server/same-origin";

export const dynamic = "force-dynamic";

/**
 * Discussion text in, proposal out. Reads the canonical file and never
 * writes it: a proposal only exists in the response.
 */
export async function POST(request: Request) {
  const refused = crossSiteRefusal(request);
  if (refused) return Response.json({ ...(await refused.json()), modelCalls: 0 }, { status: refused.status });
  const body = await request.json().catch(() => null);
  const context = contextFromBody(body);
  if (!context)
    return Response.json(
      { issues: [{ code: "invalid_request", path: "context", message: "expected { context: { sources: [...] } } or { transcript: string }" }], modelCalls: 0 },
      { status: 400 },
    );

  let provider: AgentProvider;
  try {
    provider = providerFromEnv();
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return Response.json(
      { issues: [{ code: "provider_not_configured", path: "ASM_AGENT_PROVIDER", message: error.message }], modelCalls: 0 },
      { status: 500 },
    );
  }

  const stored = await loadProduct();
  if (!stored.ok) return Response.json({ issues: stored.issues, modelCalls: 0 }, { status: loadFailureStatus(stored.issues) });

  // How many model calls this submission made (1, or 2 with the one repair request): observability only, no secret in it.
  const trace = { modelCalls: 0 };
  const proposal = await buildProposal(stored.product, context, provider, trace);
  if (!proposal.ok) {
    const providerFailed = proposal.issues.some((issue) => issue.code === "provider_error");
    return Response.json({ issues: proposal.issues, provider: provider.name, modelCalls: trace.modelCalls }, { status: providerFailed ? 502 : 422 });
  }
  return Response.json({ patch: proposal.patch, provider: provider.name, modelCalls: trace.modelCalls });
}
