import { providerFromEnv, startProposal } from "../../../agent/narrative-builder";
import { ProviderError, type AgentProvider } from "../../../agent/provider";
import { contextFromBody } from "../../../domain/context";
import { productFileExists, productFilePath } from "../../../server/store";
import { crossSiteRefusal } from "../../../server/same-origin";

export const dynamic = "force-dynamic";

/**
 * A first product: name and free text in, proposal out. Only while no product
 * file exists. Writes nothing: the proposal only exists in the response.
 */
export async function POST(request: Request) {
  const refused = crossSiteRefusal(request);
  if (refused) return Response.json({ ...(await refused.json()), modelCalls: 0 }, { status: refused.status });
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const context = contextFromBody(body);
  if (typeof body?.name !== "string" || !context)
    return Response.json(
      { issues: [{ code: "invalid_request", path: "(body)", message: "expected { name: string, context: { sources: [...] } } or { name, transcript: string }" }], modelCalls: 0 },
      { status: 400 },
    );

  if (await productFileExists())
    return Response.json(
      { issues: [{ code: "product_exists", path: productFilePath(), message: "a product already exists here; a first product can only be started where there is none" }], modelCalls: 0 },
      { status: 409 },
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

  // How many model calls this submission made (1, or 2 with the one repair request): observability only, no secret in it.
  const trace = { modelCalls: 0 };
  const proposal = await startProposal(body.name, context, provider, trace);
  if (!proposal.ok) {
    const providerFailed = proposal.issues.some((issue) => issue.code === "provider_error");
    return Response.json({ issues: proposal.issues, provider: provider.name, modelCalls: trace.modelCalls }, { status: providerFailed ? 502 : 422 });
  }
  return Response.json({ patch: proposal.patch, provider: provider.name, modelCalls: trace.modelCalls });
}
