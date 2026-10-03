import { fingerprint } from "../../../../domain/fingerprint";
import { DomainError, approveRevision } from "../../../../domain/operations";
import { loadProduct, saveProduct, loadFailureStatus, transaction } from "../../../../server/store";
import { crossSiteRefusal } from "../../../../server/same-origin";

export const dynamic = "force-dynamic";

/** The explicit proposed -> approved transition. */
export async function POST(request: Request) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { approvedBy?: unknown; mapFingerprint?: unknown } | null;
  const approvedBy = typeof body?.approvedBy === "string" ? body.approvedBy : "";
  const seen = typeof body?.mapFingerprint === "string" ? body.mapFingerprint : "";

  // One transaction: the check is against the file as it is when this writes (external review round 4).
  return transaction(async (store) => {
    const stored = await store.loadProduct();
    if (!stored.ok) return Response.json({ issues: stored.issues }, { status: loadFailureStatus(stored.issues) });
    // An approval is of what the human looked at: the request names that map's fingerprint, and it has to be
    // the map as it is now, inside this transaction (external review round 7).
    if (seen === "" || seen !== fingerprint(stored.product))
      return Response.json(
        { issues: [{ code: "stale_approval", path: "mapFingerprint", message: seen === "" ? "say which map you approve: send its fingerprint" : "the map has changed since you looked at it; read it again before approving" }] },
        { status: 409 },
      );

    try {
      const approved = approveRevision(stored.product, {
        approvedBy,
        approvedAt: new Date().toISOString(),
      });
      const saved = await store.saveProduct(approved);
      if (!saved.ok) return Response.json({ issues: saved.issues }, { status: loadFailureStatus(saved.issues) === 404 ? 404 : 422 });
      return Response.json({ product: saved.product });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return Response.json(
        { issues: [{ code: "approval_rejected", path: "revision", message: error.message }] },
        { status: 409 },
      );
    }
  });
}
