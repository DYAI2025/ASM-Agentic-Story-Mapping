import { applyMapPatch } from "../../../../domain/map-patch";
import { loadProduct, saveProduct, loadFailureStatus } from "../../../../server/store";

export const dynamic = "force-dynamic";

/**
 * The human accepted a proposal (possibly after editing it). This is the only
 * route by which a proposal reaches the canonical file. The patch is validated
 * again against the file as it is now; the result is a new proposed revision.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { patch?: unknown } | null;
  if (!body || body.patch === undefined)
    return Response.json(
      { issues: [{ code: "invalid_request", path: "patch", message: "expected { patch }" }] },
      { status: 400 },
    );

  const stored = await loadProduct();
  if (!stored.ok) return Response.json({ issues: stored.issues }, { status: loadFailureStatus(stored.issues) });

  const applied = applyMapPatch(stored.product, body.patch);
  if (!applied.ok) {
    const stale = applied.issues.some((issue) => issue.code === "stale_patch");
    return Response.json({ issues: applied.issues }, { status: stale ? 409 : 422 });
  }

  const saved = await saveProduct(applied.product);
  if (!saved.ok) return Response.json({ issues: saved.issues }, { status: 422 });
  return Response.json({ product: saved.product });
}
