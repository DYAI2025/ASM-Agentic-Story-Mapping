import { resetProduct } from "../../../../server/store";
import { crossSiteRefusal } from "../../../../server/same-origin";

export const dynamic = "force-dynamic";

/** The words the human has to send. A reset is never a side effect of some other request. */
export const RESET_CONFIRMATION = "start over";

/**
 * Start over: removes the user-workspace product and its work state, so the
 * next page load is the start screen. Only with the explicit confirmation;
 * never for the repository seed (409); nothing to remove is 404; a reset that
 * fails half-way is 500 and leaves the old product in place.
 */
export async function POST(request: Request) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { confirm?: unknown; productId?: unknown; mapFingerprint?: unknown } | null;
  if (body?.confirm !== RESET_CONFIRMATION)
    return Response.json(
      { issues: [{ code: "confirmation_required", path: "confirm", message: `send { "confirm": "${RESET_CONFIRMATION}" } to start over` }] },
      { status: 400 },
    );
  // The confirmation names the product the human saw (external review round 7).
  if (typeof body.productId !== "string" || typeof body.mapFingerprint !== "string" || body.productId === "" || body.mapFingerprint === "")
    return Response.json(
      { issues: [{ code: "confirmation_required", path: "productId", message: "say which product you start over from: send its id and map fingerprint" }] },
      { status: 400 },
    );

  const result = await resetProduct({ productId: body.productId, mapFingerprint: body.mapFingerprint });
  if (result.ok) return Response.json(result);
  const code = result.issues[0]?.code;
  return Response.json({ issues: result.issues }, { status: code === "seed_protected" || code === "product_changed" ? 409 : code === "no_product" ? 404 : 500 });
}
