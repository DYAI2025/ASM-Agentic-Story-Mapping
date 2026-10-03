import { DomainError } from "../../../../domain/operations";
import { WORK_STATE_VERSION, acceptValueException } from "../../../../domain/work-state";
import { loadProduct, loadWorkState, saveWorkState, loadFailureStatus } from "../../../../server/store";

export const dynamic = "force-dynamic";

/**
 * A named human accepts, with a rationale, that the selected slice references
 * no need. A separate step after selecting; written to the work state only.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { rationale?: unknown; acceptedBy?: unknown } | null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");

  const stored = await loadProduct();
  if (!stored.ok) return Response.json({ issues: stored.issues }, { status: loadFailureStatus(stored.issues) });
  const work = await loadWorkState();
  if (!work.ok) return Response.json({ issues: work.issues }, { status: 500 });
  if (!work.state.selection)
    return Response.json(
      { issues: [{ code: "selection_required", path: "selection", message: "no slice has been selected; select one before accepting a value exception" }] },
      { status: 409 },
    );

  try {
    const selection = acceptValueException(stored.product, work.state.selection, {
      rationale: text(body?.rationale),
      acceptedBy: text(body?.acceptedBy),
      acceptedAt: new Date().toISOString(),
    });
    const saved = await saveWorkState({ ...work.state, workStateVersion: WORK_STATE_VERSION, selection });
    if (!saved.ok) return Response.json({ issues: saved.issues }, { status: 422 });
    return Response.json({ selection: saved.state.selection });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return Response.json(
      { issues: [{ code: "exception_rejected", path: "selection.valueException", message: error.message }] },
      { status: 409 },
    );
  }
}
