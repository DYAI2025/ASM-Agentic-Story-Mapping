"use client";

import { useMemo, useRef, useState } from "react";
import { fingerprint } from "../domain/fingerprint";
import type { ProductDocument } from "../domain/schema";
import { proposeSlices, type SliceCandidate } from "../domain/slices";
import type { ValidationIssue } from "../domain/validate";
import { resolveSelection, valueStatus, type SliceSelection, type ValueStatus } from "../domain/work-state";

type Answer = { selection?: SliceSelection; issues?: ValidationIssue[] };

const VALUE_LABEL: Record<ValueStatus, string> = {
  VALUE_RESOLVED: "references a need on the map",
  VALUE_UNRESOLVED: "references no need",
  VALUE_EXCEPTION_ACCEPTED: "references no need; a human accepted that",
};

/** What changed, by the part of the selection that no longer matches. */
const STALE_REASON: Record<string, string> = {
  "selection.productId": "Product Map changed",
  "selection.mapFingerprint": "Product Map changed",
  "selection.derivationVersion": "Derivation changed",
  "selection.candidateFingerprint": "Candidate changed",
};

const DETAILS: { key: keyof SliceCandidate & ("whyNow" | "assumptions" | "unresolvedQuestions" | "acceptanceCriteria" | "outOfScope"); label: string }[] = [
  { key: "whyNow", label: "Why now" },
  { key: "assumptions", label: "Assumptions" },
  { key: "unresolvedQuestions", label: "Unresolved questions" },
  { key: "acceptanceCriteria", label: "Suggested acceptance criteria" },
  { key: "outOfScope", label: "Out of scope" },
];

/**
 * Slice candidates side by side. The candidates are computed from the map;
 * the drawer never picks one. Selecting needs a named human and an approved
 * revision. The selection is work state, handed in from outside the product
 * document. A work order can be exported once the selected slice references a
 * need, or a named human has accepted, with a rationale, that it does not.
 *
 * A selection that no longer matches the map is stale. It is shown as stale,
 * never as "nothing selected", and it is left alone: only a human selecting
 * again replaces it.
 */
export function SliceDrawer({
  product,
  selection: stored,
  onClose,
  onSelection,
}: {
  product: ProductDocument;
  /** The selection as it is in the work state, stale or not; null when no slice was ever selected. */
  selection: SliceSelection | null;
  onClose: () => void;
  onSelection: (selection: SliceSelection) => void;
}) {
  const [selector, setSelector] = useState("");
  const [rationale, setRationale] = useState("");
  const [accepter, setAccepter] = useState("");
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  const proposal = useMemo(() => proposeSlices(product), [product]);
  const mapFingerprint = useMemo(() => fingerprint(product), [product]);
  const approved = product.revision.status === "approved";
  const resolution = useMemo(() => (stored ? resolveSelection(product, stored) : null), [product, stored]);
  // Only a selection that still matches this map counts as selected.
  const selection = resolution?.ok ? stored : null;
  const stale = stored && resolution && !resolution.ok ? { selection: stored, issue: resolution.issues[0] } : null;
  const staleCandidate = stale && proposal.ok ? proposal.candidates.find((c) => c.id === stale.selection.candidateId) : undefined;
  const selectorInput = useRef<HTMLInputElement>(null);
  const comparison = useRef<HTMLTableElement>(null);
  const selected = proposal.ok && selection ? proposal.candidates.find((c) => c.id === selection.candidateId) : undefined;
  const selectedValue = selected ? valueStatus(product, selected, selection) : null;
  const name = (ids: string[], items: { id: string; name: string }[]) =>
    ids.map((id) => items.find((e) => e.id === id)?.name ?? id).join(", ");

  async function post(url: string, body: object) {
    setBusy(true);
    let answer: Answer;
    try {
      const response = await fetch(url, { method: "POST", body: JSON.stringify(body) });
      answer = (await response.json()) as Answer;
    } catch (error) {
      answer = { issues: [{ code: "request_failed", path: url, message: error instanceof Error ? error.message : String(error) }] };
    }
    setBusy(false);
    if (!answer.selection) {
      setIssues(answer.issues ?? [{ code: "unknown_error", path: url, message: "request failed" }]);
      return;
    }
    setIssues([]);
    onSelection(answer.selection);
  }

  const select = (candidateId: string) => post("/api/slices/select", { candidateId, selectedBy: selector, mapFingerprint });
  const acceptException = () => post("/api/slices/exception", { rationale, acceptedBy: accepter });

  const rows: { label: string; value: (c: SliceCandidate) => string }[] = [
    { label: "Scope", value: (c) => `${c.evidence.stepCount} of ${c.evidence.totalSteps} steps` },
    { label: "Personas", value: (c) => name(c.personaIds, product.personas) },
    { label: "Needs served", value: (c) => `${c.evidence.needsServed} of ${c.evidence.totalNeeds}` },
    { label: "Value", value: (c) => valueStatus(product, c, selection) },
    {
      label: "Main path",
      value: (c) =>
        c.evidence.includesStart && c.evidence.includesEnd
          ? "start and end"
          : c.evidence.includesStart
            ? "start, not the end"
            : c.evidence.includesEnd
              ? "end, not the start"
              : "neither start nor end",
    },
    { label: "Primary persona in", value: (c) => `${c.evidence.primaryPersonaSteps} of ${c.evidence.stepCount} steps` },
    { label: "Shared steps", value: (c) => `${c.evidence.sharedSteps} of ${c.evidence.stepCount}` },
    { label: "Worst cases to handle", value: (c) => String(c.evidence.worstCaseIds.length) },
    { label: "Open decisions", value: (c) => String(c.evidence.openDecisionIds.length) },
    { label: "Review gaps", value: (c) => String(c.evidence.reviewGapIds.length) },
    { label: "Flags", value: (c) => (c.flags.length > 0 ? c.flags.map((f) => f.code).join(", ") : "none") },
  ];

  return (
    <aside className="drawer" aria-label="Slice candidates" data-testid="slice-drawer">
      <header className="row drawer-head">
        <h2>First slice candidates</h2>
        <button type="button" className="secondary" data-testid="slices-close" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="muted">
        Computed from revision {product.revision.number} of the map (<code>{mapFingerprint}</code>). The order is not a
        ranking and there is no score: the rows below are counts taken from the map. ASM does not select a slice.
      </p>

      {!proposal.ok && (
        <div className="panel error" role="alert" data-testid="slice-issues">
          <strong>No candidates.</strong>
          <ul>
            {proposal.issues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      {proposal.ok && (
        <>
          <div className="gate" data-testid="slice-gate" data-selection-state={stale ? "stale" : selection ? "current" : "none"}>
            {stale && (
              <div className="stale" role="status" data-testid="selection-stale">
                <p data-testid="stale-heading">
                  <strong>⚠ Stale selection.</strong> A slice was selected earlier, and it no longer matches the map. It
                  is not the selected slice, and no work order can be exported from it.
                </p>
                <p data-testid="stale-previous">
                  Previously selected: <code>{stale.selection.candidateId}</code>{" "}
                  {staleCandidate ? (
                    <>
                      — {staleCandidate.title}{" "}
                      <span className="muted">(the title the current map gives this candidate id)</span>
                    </>
                  ) : (
                    <span className="muted">(no candidate with this id is derived from the current map)</span>
                  )}{" "}
                  <span className="muted">
                    by {stale.selection.selectedBy} · {stale.selection.selectedAt} · revision {stale.selection.revision} ·
                    map <code>{stale.selection.mapFingerprint}</code>
                  </span>
                </p>
                <p data-testid="stale-reason" data-reason={stale.issue.path}>
                  Reason: <strong>{STALE_REASON[stale.issue.path] ?? "Selection no longer matches"}</strong> —{" "}
                  {stale.issue.message}.
                </p>
                <p className="muted">
                  The candidates below are derived again from the map as it is now. ASM does not repair, replace or
                  delete the stale selection: it stays in the work state until a human selects a slice again.
                </p>
                <button
                  type="button"
                  data-testid="reselect-candidates"
                  onClick={() => {
                    comparison.current?.scrollIntoView({ block: "nearest" });
                    selectorInput.current?.focus();
                  }}
                >
                  Reselect from current candidates
                </button>
              </div>
            )}
            {selection && selected && selectedValue ? (
              <>
                <p data-testid="selection-record">
                  <strong>Selected: {selected.title}</strong>{" "}
                  <span className="muted">
                    by {selection.selectedBy} · {selection.selectedAt} · revision {selection.revision}
                  </span>
                </p>
                <p data-testid="value-status" data-value={selectedValue}>
                  Value: <code>{selectedValue}</code> <span className="muted">— {VALUE_LABEL[selectedValue]}</span>
                </p>
                {selection.valueException && selectedValue === "VALUE_EXCEPTION_ACCEPTED" && (
                  <p data-testid="value-exception-record">
                    Exception accepted by {selection.valueException.acceptedBy} · {selection.valueException.acceptedAt}:{" "}
                    “{selection.valueException.rationale}”{" "}
                    <span className="muted">This authorizes the work under uncertainty. It is not proof of value.</span>
                  </p>
                )}
                {selectedValue === "VALUE_UNRESOLVED" ? (
                  <form
                    className="exception"
                    data-testid="value-exception-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void acceptException();
                    }}
                  >
                    <p className="flagged">
                      ⚑ This slice references no need, so no work order can be exported. Reference a need on the map, or
                      accept that explicitly and say why. Accepting is a decision under uncertainty, not proof of value.
                    </p>
                    <label className="field">
                      <span>Why build this slice although it references no need?</span>
                      <textarea
                        aria-label="Exception rationale"
                        rows={3}
                        value={rationale}
                        onChange={(event) => setRationale(event.target.value)}
                      />
                    </label>
                    <div className="row">
                      <input
                        aria-label="Exception accepted by"
                        placeholder="Your name"
                        value={accepter}
                        onChange={(event) => setAccepter(event.target.value)}
                      />
                      <button type="submit" data-testid="accept-value-exception" disabled={busy}>
                        Accept value exception
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="row">
                    <a className="button" href="/api/brief?format=md" data-testid="export-work-order-md">
                      Export work order (Markdown)
                    </a>
                    <a className="button secondary" href="/api/brief?format=json" data-testid="export-work-order-json">
                      Export work order (JSON)
                    </a>
                  </div>
                )}
              </>
            ) : approved ? (
              <label className="row">
                <span>Selecting as</span>
                <input
                  ref={selectorInput}
                  aria-label="Selector name"
                  placeholder="Your name"
                  value={selector}
                  onChange={(event) => setSelector(event.target.value)}
                />
                {stale ? (
                  <span className="muted" data-testid="selection-reselect-hint">
                    Select a slice below to replace the stale selection. Until then no work order can be exported.
                  </span>
                ) : (
                  <span className="muted" data-testid="selection-none">
                    No slice is selected. A work order can be exported once you select one.
                  </span>
                )}
              </label>
            ) : (
              <p data-testid="slice-needs-approval">
                Revision {product.revision.number} is only proposed. A slice can be selected once a human has approved
                the narrative.
              </p>
            )}
          </div>

          <table ref={comparison} className="comparison" data-testid="slice-comparison">
            <thead>
              <tr>
                <th />
                {proposal.candidates.map((c) => (
                  <th key={c.id} className={selection?.candidateId === c.id ? "chosen" : ""}>
                    {c.title}
                    <br />
                    <code>{c.id}</code>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th>{row.label}</th>
                  {proposal.candidates.map((c) => (
                    <td key={c.id} className={selection?.candidateId === c.id ? "chosen" : ""}>
                      {row.value(c)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th />
                {proposal.candidates.map((c) => (
                  <td key={c.id}>
                    <button
                      type="button"
                      data-testid={`select-${c.id}`}
                      disabled={busy || !approved || selection?.candidateId === c.id}
                      onClick={() => void select(c.id)}
                    >
                      {selection?.candidateId === c.id ? "Selected" : "Select slice"}
                    </button>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>

          {issues.length > 0 && (
            <div className="panel error" role="alert" data-testid="slice-issues">
              <strong>Not done.</strong>
              <ul>
                {issues.map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="candidates">
            {proposal.candidates.map((c) => (
              <article
                key={c.id}
                className={`card candidate ${selection?.candidateId === c.id ? "chosen" : ""}`}
                data-testid={`candidate-${c.id}`}
              >
                <h3>{c.title}</h3>
                {c.flags.map((flag) => (
                  <p key={flag.code} className="flagged" data-testid={`flag-${c.id}`}>
                    ⚑ {flag.message}
                  </p>
                ))}
                <p className="muted">
                  Steps: {c.stepIds.map((id) => <code key={id}>{id} </code>)}
                </p>
                <p className="muted">
                  Needs: {c.needIds.length > 0 ? c.needIds.map((id) => <code key={id}>{id} </code>) : "none"}
                </p>
                {DETAILS.map(({ key, label }) => (
                  <details key={key} open={key === "whyNow"}>
                    <summary>
                      {label} ({c[key].length})
                    </summary>
                    <ul>
                      {c[key].map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  </details>
                ))}
              </article>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
