/**
 * A request a browser marks as coming from another site is refused on every
 * route that changes something or spends a model call. Without this, a page
 * on any other site could make a visitor's browser post a reset, an approval
 * or a selection to the app on localhost (external review F2).
 *
 * Browsers set `Sec-Fetch-Site` and, on cross-origin writes, `Origin`; a
 * same-origin request carries `same-origin`, a navigation `none`. Clients
 * that are not browsers (tests, curl) send neither and are let through:
 * this is not authentication, it is the one thing a browser can be made to
 * do against its user. Deciding who may reach the port at all is the next
 * slice.
 */
export function crossSiteRefusal(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  let refused = false;
  if (site !== null && site !== "same-origin" && site !== "none") refused = true;
  if (origin !== null) {
    const host = request.headers.get("host");
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost === null || host === null || originHost !== host) refused = true;
  }
  if (!refused) return null;
  return Response.json(
    { issues: [{ code: "cross_site_request", path: "(request)", message: "this request came from another site; ASM only changes anything from its own page" }] },
    { status: 403 },
  );
}
