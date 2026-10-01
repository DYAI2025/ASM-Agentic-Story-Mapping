import { DomainError } from "../../../../domain/operations";
import { selectSlice } from "../../../../domain/slices";
import { loadProduct, saveProduct } from "../../../../server/store";

export const dynamic = "force-dynamic";

/**
 * The human gate for slices: a named human selects one candidate of the
 * approved map they were looking at. Nothing else writes a selection.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { candidateId?: unknown; selectedBy?: unknown; mapFingerprint?: unknown }
    | null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");

  const stored = await loadProduct();
  if (!stored.ok) return Response.json({ issues: stored.issues }, { status: 500 });

  try {
    const selected = selectSlice(stored.product, {
      candidateId: text(body?.candidateId),
      selectedBy: text(body?.selectedBy),
      mapFingerprint: text(body?.mapFingerprint),
      selectedAt: new Date().toISOString(),
    });
    const saved = await saveProduct(selected);
    if (!saved.ok) return Response.json({ issues: saved.issues }, { status: 422 });
    return Response.json({ product: saved.product });
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return Response.json(
      { issues: [{ code: "selection_rejected", path: "selectedSlice", message: error.message }] },
      { status: 409 },
    );
  }
}
