"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  EDITABLE_OP_FIELDS,
  applyMapPatch,
  describePatch,
  type MapPatch,
  type PatchOperation,
  type Touch,
} from "../domain/map-patch";
import type { ProductDocument } from "../domain/schema";
import type { ValidationIssue } from "../domain/validate";

export interface ProposalPreview {
  product: ProductDocument;
  touched: Record<string, Touch>;
}

type ApiResult = {
  patch?: MapPatch;
  product?: ProductDocument;
  provider?: string;
  issues?: ValidationIssue[];
};

async function post(url: string, body: unknown): Promise<ApiResult> {
  try {
    const response = await fetch(url, { method: "POST", body: JSON.stringify(body) });
    return (await response.json()) as ApiResult;
  } catch (error) {
    return {
      issues: [{ code: "request_failed", path: url, message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

const DEFAULT_ENDPOINTS = { propose: "/api/proposal", accept: "/api/proposal/accept" };
const NO_EXTRA = {};

/**
 * Paste a discussion, get a proposal, review it, then accept or reject it.
 * The proposal lives only in this component until the human accepts it.
 *
 * The same panel starts a first product: there `product` is the blank draft,
 * and `endpoints` and `extra` send the proposal to the routes that create a
 * product instead of changing one.
 */
export function WorkshopPanel({
  product,
  onPreview,
  onReviewing,
  onAccepted,
  endpoints = DEFAULT_ENDPOINTS,
  extra = NO_EXTRA,
  labels,
  hint,
  blocked,
}: {
  product: ProductDocument;
  onPreview: (preview: ProposalPreview | null) => void;
  onReviewing: (reviewing: boolean) => void;
  onAccepted: (product: ProductDocument) => void;
  endpoints?: { propose: string; accept: string };
  /** Sent along with every request, next to the transcript or the patch. */
  extra?: Record<string, unknown>;
  labels?: { heading: string; intro: string; placeholder: string; button: string; busy: string; acceptNote: string };
  hint?: ReactNode;
  /** Why a proposal cannot be asked for yet. The text can still be written. */
  blocked?: string;
}) {
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [status, setStatus] = useState("");
  const [patch, setPatch] = useState<MapPatch | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);

  const effective = useMemo(
    () => (patch ? { ...patch, operations: patch.operations.filter((o) => !excluded.has(o.opId)) } : null),
    [patch, excluded],
  );
  const result = useMemo(() => (effective ? applyMapPatch(product, effective) : null), [product, effective]);
  const entries = useMemo(() => (patch ? describePatch(product, patch) : []), [product, patch]);

  useEffect(() => {
    onPreview(result?.ok ? { product: result.product, touched: result.touched } : null);
  }, [result, onPreview]);
  useEffect(() => {
    onReviewing(patch !== null);
  }, [patch, onReviewing]);

  function close(message: string) {
    setPatch(null);
    setExcluded(new Set());
    setEditing(false);
    setIssues([]);
    setStatus(message);
  }

  async function structure() {
    setBusy(true);
    setStatus("");
    const answer = await post(endpoints.propose, { ...extra, transcript });
    setBusy(false);
    if (!answer.patch) {
      setIssues(answer.issues ?? [{ code: "unknown_error", path: endpoints.propose, message: "request failed" }]);
      return;
    }
    setIssues([]);
    setExcluded(new Set());
    setEditing(false);
    setPatch(answer.patch);
  }

  async function accept() {
    if (!effective) return;
    setBusy(true);
    const answer = await post(endpoints.accept, { ...extra, patch: effective });
    setBusy(false);
    if (!answer.product) {
      setIssues(answer.issues ?? [{ code: "unknown_error", path: endpoints.accept, message: "request failed" }]);
      return;
    }
    const revision = answer.product.revision.number;
    onAccepted(answer.product);
    setTranscript("");
    close(`Proposal accepted. The map is now proposed revision ${revision}.`);
  }

  function editOperation(opId: string, field: string, value: string) {
    if (!patch) return;
    setPatch({
      ...patch,
      operations: patch.operations.map((o) => (o.opId === opId ? ({ ...o, [field]: value } as PatchOperation) : o)),
    });
  }

  function toggle(opId: string) {
    const next = new Set(excluded);
    if (next.has(opId)) next.delete(opId);
    else next.add(opId);
    setExcluded(next);
  }

  const shownIssues = issues.length > 0 ? issues : result && !result.ok ? result.issues : [];
  const includedCount = effective?.operations.length ?? 0;

  return (
    <section className="panel workshop" aria-label="Workshop input" data-testid="workshop">
      <h2>{labels?.heading ?? "Workshop input"}</h2>

      {!patch && (
        <>
          <p className="muted">
            {labels?.intro ??
              "Paste a product discussion, notes or a workshop transcript. The text is treated as material to analyse, never as instructions. You get a proposal to review; the map does not change until you accept it."}
          </p>
          {hint}
          <textarea
            id="workshop-input"
            data-testid="transcript-input"
            aria-label="Discussion text"
            rows={8}
            placeholder={labels?.placeholder ?? "Paste discussion, notes or transcript…"}
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
          />
          <div className="row actions">
            <button
              type="button"
              data-testid="structure-button"
              disabled={busy || transcript.trim() === "" || blocked !== undefined}
              onClick={() => void structure()}
            >
              {busy ? (labels?.busy ?? "Structuring…") : (labels?.button ?? "Structure discussion")}
            </button>
            {blocked && (
              <span className="muted" data-testid="proposal-blocked">
                {blocked}
              </span>
            )}
            {status && (
              <span className="muted" data-testid="proposal-status">
                {status}
              </span>
            )}
          </div>
        </>
      )}

      {patch && (
        <div id="proposal-review" tabIndex={-1} data-testid="proposal-review">
          <p>
            <strong>Proposal</strong> <span className="muted">from {patch.provider}</span>
          </p>
          {patch.summary && <p className="muted">{patch.summary}</p>}

          <ol className="diff">
            {entries.map((entry) => {
              const operation = patch.operations.find((o) => o.opId === entry.opId)!;
              const included = !excluded.has(entry.opId);
              const fields = EDITABLE_OP_FIELDS[operation.op];
              return (
                <li
                  key={entry.opId}
                  className={`diff-entry ${entry.op} ${included ? "" : "excluded"}`}
                  data-testid={`diff-${entry.opId}`}
                  data-op={entry.op}
                >
                  <label className="row">
                    <input
                      type="checkbox"
                      checked={included}
                      aria-label={`Include ${entry.opId}`}
                      onChange={() => toggle(entry.opId)}
                    />
                    <strong>{entry.headline}</strong>
                  </label>

                  {editing && included && fields.length > 0 ? (
                    fields.map((field) => (
                      <label key={field} className="field">
                        <span>{field}</span>
                        <textarea
                          name={`${entry.opId}-${field}`}
                          rows={2}
                          value={String((operation as Record<string, unknown>)[field] ?? "")}
                          onChange={(event) => editOperation(entry.opId, field, event.target.value)}
                        />
                      </label>
                    ))
                  ) : (
                    <>
                      {entry.before !== undefined && <p className="before">− {entry.before}</p>}
                      {entry.after && <p className="after">+ {entry.after}</p>}
                    </>
                  )}

                  <blockquote className="source">
                    “{entry.source.snippet}”
                    <footer>
                      {entry.source.rationale}{" "}
                      <span className="muted">
                        · confidence {entry.source.confidence.toFixed(2)} (advisory only) · <code>{entry.targetId}</code>
                      </span>
                    </footer>
                  </blockquote>
                </li>
              );
            })}
          </ol>

          <div className="row actions">
            <button
              type="button"
              data-testid="proposal-accept"
              disabled={busy || !result?.ok}
              onClick={() => void accept()}
            >
              Accept {includedCount} change{includedCount === 1 ? "" : "s"}
            </button>
            <button
              type="button"
              className="secondary"
              data-testid="proposal-edit"
              onClick={() => setEditing(!editing)}
            >
              {editing ? "Done editing" : "Edit"}
            </button>
            <button
              type="button"
              className="secondary"
              data-testid="proposal-reject"
              onClick={() => close("Proposal rejected. The map was not changed.")}
            >
              Reject
            </button>
            <span className="muted">
              {labels?.acceptNote ?? `Accepting creates proposed revision ${product.revision.number + 1}. It does not approve it.`}
            </span>
          </div>
        </div>
      )}

      {shownIssues.length > 0 && (
        <div className="panel error" role="alert" data-testid="proposal-issues">
          <strong>{patch ? "This proposal cannot be accepted as it stands." : "No proposal."}</strong>
          <ul>
            {shownIssues.map((issue, i) => (
              <li key={i}>
                <code>{issue.path}</code> — {issue.message} <small>({issue.code})</small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
