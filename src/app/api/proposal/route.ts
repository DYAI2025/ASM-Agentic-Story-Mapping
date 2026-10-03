import { buildProposal, providerFromEnv } from "../../../agent/narrative-builder";
import { ProviderError, type AgentProvider } from "../../../agent/provider";
import { contextFromBody } from "../../../domain/context";
import { loadProduct, loadFailureStatus } from "../../../server/store";

export const dynamic = "force-dynamic";

/**
 * Discussion text in, proposal out. Reads the canonical file and never
 * writes it: a proposal only exists in the response.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const context = contextFromBody(body);
  if (!context)
    return Response.json(
      { issues: [{ code: "invalid_request", path: "context", message: "expected { context: { sources: [...] } } or { transcript: string }" }] },
      { status: 400 },
    );

  let provider: AgentProvider;
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

  const proposal = await buildProposal(stored.product, context, provider);
  if (!proposal.ok) {
    const providerFailed = proposal.issues.some((issue) => issue.code === "provider_error");
    return Response.json({ issues: proposal.issues, provider: provider.name }, { status: providerFailed ? 502 : 422 });
  }
  return Response.json({ patch: proposal.patch, provider: provider.name });
}
