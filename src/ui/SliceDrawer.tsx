"use client";

import { useMemo, useState } from "react";
import { fingerprint } from "../domain/fingerprint";
import type { ProductDocument } from "../domain/schema";
import { proposeSlices, type SliceCandidate } from "../domain/slices";
import type { ValidationIssue } from "../domain/validate";

type Answer = { product?: ProductDocument; issues?: ValidationIssue[] };

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
 * revision, and only then can the work order be exported.
 */
export function SliceDrawer({
  product,
  onClose,
  onSelected,
}: {
  product: ProductDocument;
  onClose: () => void;
  onSelected: (product: ProductDocument) => void;
}) {
  const [selector, setSelector] = useState("");
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  const proposal = useMemo(() => proposeSlices(product), [product]);
  const mapFingerprint = useMemo(() => fingerprint(product), [product]);
  const approved = product.revision.status === "approved";
  const selection = product.selectedSlice;
  const name = (ids: string[], items: { id: string; name: string }[]) =>
    ids.map((id) => items.find((e) => e.id === id)?.name ?? id).join(", ");

  async function select(candidateId: string) {
    setBusy(true);
    let answer: Answer;
    try {
      const response = await fetch("/api/slices/select", {
        method: "POST",
        body: JSON.stringify({ candidateId, selectedBy: selector, mapFingerprint }),
      });
      answer = (await response.json()) as Answer;
    } catch (error) {
      answer = { issues: [{ code: "request_failed", path: "/api/slices/select", message: error instanceof Error ? error.message : String(error) }] };
    }
    setBusy(false);
    if (!answer.product) {
      setIssues(answer.issues ?? [{ code: "unknown_error", path: "/api/slices/select", message: "request failed" }]);
      return;
    }
    setIssues([]);
    onSelected(answer.product);
  }

  const rows: { label: string; value: (c: SliceCandidate) => string }[] = [
    { label: "Scope", value: (c) => `${c.evidence.stepCount} of ${c.evidence.totalSteps} steps` },
    { label: "Personas", value: (c) => name(c.personaIds, product.personas) },
    { label: "Needs served", value: (c) => `${c.evidence.needsServed} of ${c.evidence.totalNeeds}` },
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
          <div className="gate" data-testid="slice-gate">
            {selection ? (
              <>
                <p data-testid="selection-record">
                  <strong>Selected: {selection.title}</strong>{" "}
                  <span className="muted">
                    by {selection.selectedBy} · {selection.selectedAt} · revision {selection.revision}
                  </span>
                </p>
                <div className="row">
                  <a className="button" href="/api/brief?format=md" data-testid="export-work-order-md">
                    Export work order (Markdown)
                  </a>
                  <a className="button secondary" href="/api/brief?format=json" data-testid="export-work-order-json">
                    Export work order (JSON)
                  </a>
                </div>
              </>
            ) : approved ? (
              <label className="row">
                <span>Selecting as</span>
                <input
                  aria-label="Selector name"
                  placeholder="Your name"
                  value={selector}
                  onChange={(event) => setSelector(event.target.value)}
                />
                <span className="muted">No slice is selected. A work order can be exported once you select one.</span>
              </label>
            ) : (
              <p data-testid="slice-needs-approval">
                Revision {product.revision.number} is only proposed. A slice can be selected once a human has approved
                the narrative.
              </p>
            )}
          </div>

          <table className="comparison" data-testid="slice-comparison">
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
              <strong>Not selected.</strong>
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
