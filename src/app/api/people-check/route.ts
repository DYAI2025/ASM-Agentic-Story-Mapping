import { DomainError } from "../../../domain/operations";
import { WORK_STATE_VERSION, confirmPersonaCheck } from "../../../domain/work-state";
import { loadProduct, loadWorkState, saveWorkState, loadFailureStatus, transaction } from "../../../server/store";
import { crossSiteRefusal } from "../../../server/same-origin";

export const dynamic = "force-dynamic";

/**
 * The human gate before slicing: a named human confirms, for the approved map
 * they were looking at, that they considered who else is relevant. Nothing
 * else writes this, and it is written to the work state, never to the product
 * file. An earlier selection is left as it is; it is stale or not on its own
 * terms.
 */
export async function POST(request: Request) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { confirmedBy?: unknown; mapFingerprint?: unknown } | null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");

  // One transaction: the check is against the file as it is when this writes (external review round 4).
  return transaction(async (store) => {
    const stored = await store.loadProduct();
    if (!stored.ok) return Response.json({ issues: stored.issues }, { status: loadFailureStatus(stored.issues) });
    const work = await store.loadWorkState();
    if (!work.ok) return Response.json({ issues: work.issues }, { status: 500 });

    try {
      const personaCheck = confirmPersonaCheck(stored.product, {
        confirmedBy: text(body?.confirmedBy),
        mapFingerprint: text(body?.mapFingerprint),
        confirmedAt: new Date().toISOString(),
      });
      const saved = await store.saveWorkState({ ...work.state, workStateVersion: WORK_STATE_VERSION, personaCheck });
      if (!saved.ok) return Response.json({ issues: saved.issues }, { status: loadFailureStatus(saved.issues) === 404 ? 404 : 422 });
      return Response.json({ personaCheck: saved.state.personaCheck });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return Response.json({ issues: [{ code: "people_check_rejected", path: "personaCheck", message: error.message }] }, { status: 409 });
    }
  });
}
