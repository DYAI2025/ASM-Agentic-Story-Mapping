import { DomainError } from "../../../../domain/operations";
import { WORK_STATE_VERSION, selectSlice } from "../../../../domain/work-state";
import { loadProduct, saveWorkState } from "../../../../server/store";

export const dynamic = "force-dynamic";

/**
 * The human gate for slices: a named human selects one candidate of the
 * approved map they were looking at. Nothing else writes a selection, and the
 * selection is written to the work state, never to the product file.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { candidateId?: unknown; selectedBy?: unknown; mapFingerprint?: unknown }
    | null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");

  const stored = await loadProduct();
  if (!stored.ok) return Response.json({ issues: stored.issues }, { status: 500 });

  try {
    const selection = selectSlice(stored.product, {
      candidateId: text(body?.candidateId),
      selectedBy: text(body?.selectedBy),
      mapFingerprint: text(body?.mapFingerprint),
      selectedAt: new Date().toISOString(),
    });
    const saved = await saveWorkState({ workStateVersion: WORK_STATE_VERSION, selection });
    if (!saved.ok) return Response.json({ issues: saved.issues }, { status: 422 });
    return Response.json({ selection: saved.state.selection });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return Response.json(
      { issues: [{ code: "selection_rejected", path: "selection", message: error.message }] },
      { status: 409 },
    );
  }
}
