import { fingerprint } from "../../../domain/fingerprint";
import { SLICE_DERIVATION_VERSION, proposeSlices } from "../../../domain/slices";
import { resolvePersonaCheck, resolveSelection, valueStatus } from "../../../domain/work-state";
import { loadProduct, loadWorkState, loadFailureStatus } from "../../../server/store";

export const dynamic = "force-dynamic";

/**
 * Slice candidates for the canonical map, derived on every call, never stored,
 * never selected here. The selection comes from the work state; `selectionStale`
 * says whether it still belongs to this map.
 */
export async function GET() {
  const stored = await loadProduct();
  if (!stored.ok) return Response.json({ issues: stored.issues }, { status: loadFailureStatus(stored.issues) });
  const work = await loadWorkState();
  if (!work.ok) return Response.json({ issues: work.issues }, { status: 500 });

  const selection = work.state.selection ?? null;
  const current = selection !== null && resolveSelection(stored.product, selection).ok;
  const base = {
    revision: stored.product.revision,
    mapFingerprint: fingerprint(stored.product),
    derivationVersion: SLICE_DERIVATION_VERSION,
    selection,
    selectionStale: selection !== null && !current,
    personaCheck: work.state.personaCheck ?? null,
    personaCheckCurrent: resolvePersonaCheck(stored.product, work.state.personaCheck).ok,
  };
  const proposal = proposeSlices(stored.product);
  if (!proposal.ok) return Response.json({ ...base, issues: proposal.issues }, { status: 422 });
  return Response.json({
    ...base,
    candidates: proposal.candidates,
    fewerBecause: proposal.fewerBecause ?? null,
    valueStatus: Object.fromEntries(
      proposal.candidates.map((c) => [c.id, valueStatus(stored.product, c, current ? selection : null)]),
    ),
  });
}
