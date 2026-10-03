import { resetProduct } from "../../../../server/store";

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
  const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== RESET_CONFIRMATION)
    return Response.json(
      { issues: [{ code: "confirmation_required", path: "confirm", message: `send { "confirm": "${RESET_CONFIRMATION}" } to start over` }] },
      { status: 400 },
    );

  const result = await resetProduct();
  if (result.ok) return Response.json(result);
  const code = result.issues[0]?.code;
  return Response.json({ issues: result.issues }, { status: code === "seed_protected" ? 409 : code === "no_product" ? 404 : 500 });
}
