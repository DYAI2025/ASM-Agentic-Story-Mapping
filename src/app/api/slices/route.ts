import { fingerprint } from "../../../domain/fingerprint";
import { proposeSlices } from "../../../domain/slices";
import { loadProduct } from "../../../server/store";

export const dynamic = "force-dynamic";

/** Slice candidates for the canonical map. Derived on every call, never stored, never selected here. */
export async function GET() {
  const stored = await loadProduct();
  if (!stored.ok) return Response.json({ issues: stored.issues }, { status: 500 });

  const base = {
    revision: stored.product.revision,
    mapFingerprint: fingerprint(stored.product),
    selectedSlice: stored.product.selectedSlice ?? null,
  };
  const proposal = proposeSlices(stored.product);
  if (!proposal.ok) return Response.json({ ...base, issues: proposal.issues }, { status: 422 });
  return Response.json({ ...base, candidates: proposal.candidates });
}
