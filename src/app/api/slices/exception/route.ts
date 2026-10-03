import { DomainError } from "../../../../domain/operations";
import { WORK_STATE_VERSION, acceptValueException } from "../../../../domain/work-state";
import { loadProduct, loadWorkState, saveWorkState, loadFailureStatus, transaction } from "../../../../server/store";
import { crossSiteRefusal } from "../../../../server/same-origin";

export const dynamic = "force-dynamic";

/**
 * A named human accepts, with a rationale, that the selected slice references
 * no need. A separate step after selecting; written to the work state only.
 */
export async function POST(request: Request) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { rationale?: unknown; acceptedBy?: unknown; candidateId?: unknown } | null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");

  // One transaction: the check is against the file as it is when this writes (external review round 4).
  return transaction(async (store) => {
    const stored = await store.loadProduct();
    if (!stored.ok) return Response.json({ issues: stored.issues }, { status: loadFailureStatus(stored.issues) });
    const work = await store.loadWorkState();
    if (!work.ok) return Response.json({ issues: work.issues }, { status: 500 });
    if (!work.state.selection)
      return Response.json(
        { issues: [{ code: "selection_required", path: "selection", message: "no slice has been selected; select one before accepting a value exception" }] },
        { status: 409 },
      );
    // The exception is for the slice the human looked at: the request names it, and it has to be the one
    // selected now, inside this transaction (external review round 7).
    if (text(body?.candidateId) === "" || text(body?.candidateId) !== work.state.selection.candidateId)
      return Response.json(
        {
          issues: [
            {
              code: "selection_changed",
              path: "candidateId",
              message:
                text(body?.candidateId) === ""
                  ? "say which slice the exception is for: send its candidate id"
                  : `the selected slice is now “${work.state.selection.candidateId}”, not “${text(body?.candidateId)}”; look at it again before accepting an exception`,
            },
          ],
        },
        { status: 409 },
      );

    try {
      const selection = acceptValueException(stored.product, work.state.selection, {
        rationale: text(body?.rationale),
        acceptedBy: text(body?.acceptedBy),
        acceptedAt: new Date().toISOString(),
      });
      const saved = await store.saveWorkState({ ...work.state, workStateVersion: WORK_STATE_VERSION, selection });
      if (!saved.ok) return Response.json({ issues: saved.issues }, { status: loadFailureStatus(saved.issues) === 404 ? 404 : 422 });
      return Response.json({ selection: saved.state.selection });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return Response.json(
        { issues: [{ code: "exception_rejected", path: "selection.valueException", message: error.message }] },
        { status: 409 },
      );
    }
  });
}
