import { buildExecutionBrief, exportBriefJson, exportBriefMarkdown } from "../../../domain/brief";
import { loadProduct } from "../../../server/store";

export const dynamic = "force-dynamic";

/**
 * Export the work order for the selected slice with `?format=json|md`.
 * Refused until a human has selected a slice of the approved revision.
 */
export async function GET(request: Request) {
  const stored = await loadProduct();
  if (!stored.ok) return Response.json({ issues: stored.issues }, { status: 500 });

  const result = buildExecutionBrief(stored.product);
  if (!result.ok) return Response.json({ issues: result.issues }, { status: 409 });

  const markdown = new URL(request.url).searchParams.get("format") === "md";
  const { productId, revision } = result.brief.sourceMapRevision;
  return new Response(markdown ? exportBriefMarkdown(result.brief) : exportBriefJson(result.brief), {
    headers: {
      "content-type": markdown ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${productId}.work-order.r${revision}.${markdown ? "md" : "json"}"`,
    },
  });
}
