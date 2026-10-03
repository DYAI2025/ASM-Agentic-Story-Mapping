import { DomainError, approveRevision } from "../../../../domain/operations";
import { loadProduct, saveProduct, loadFailureStatus } from "../../../../server/store";
import { crossSiteRefusal } from "../../../../server/same-origin";

export const dynamic = "force-dynamic";

/** The explicit proposed -> approved transition. */
export async function POST(request: Request) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { approvedBy?: unknown } | null;
  const approvedBy = typeof body?.approvedBy === "string" ? body.approvedBy : "";

  const stored = await loadProduct();
  if (!stored.ok) return Response.json({ issues: stored.issues }, { status: loadFailureStatus(stored.issues) });

  try {
    const approved = approveRevision(stored.product, {
      approvedBy,
      approvedAt: new Date().toISOString(),
    });
    const saved = await saveProduct(approved);
    if (!saved.ok) return Response.json({ issues: saved.issues }, { status: 422 });
    return Response.json({ product: saved.product });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return Response.json(
      { issues: [{ code: "approval_rejected", path: "revision", message: error.message }] },
      { status: 409 },
    );
  }
}
