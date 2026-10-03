import { providerFromEnv, startProposal } from "../../../agent/narrative-builder";
import { ProviderError, type AgentProvider } from "../../../agent/provider";
import { productFileExists, productFilePath } from "../../../server/store";

export const dynamic = "force-dynamic";

/**
 * A first product: name and free text in, proposal out. Only while no product
 * file exists. Writes nothing: the proposal only exists in the response.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { name?: unknown; transcript?: unknown } | null;
  if (typeof body?.name !== "string" || typeof body?.transcript !== "string")
    return Response.json(
      { issues: [{ code: "invalid_request", path: "(body)", message: "expected { name: string, transcript: string }" }] },
      { status: 400 },
    );

  if (await productFileExists())
    return Response.json(
      { issues: [{ code: "product_exists", path: productFilePath(), message: "a product already exists here; a first product can only be started where there is none" }] },
      { status: 409 },
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

  const proposal = await startProposal(body.name, body.transcript, provider);
  if (!proposal.ok) {
    const providerFailed = proposal.issues.some((issue) => issue.code === "provider_error");
    return Response.json({ issues: proposal.issues, provider: provider.name }, { status: providerFailed ? 502 : 422 });
  }
  return Response.json({ patch: proposal.patch, provider: provider.name });
}
