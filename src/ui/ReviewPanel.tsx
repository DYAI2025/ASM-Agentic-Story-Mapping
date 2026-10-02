"use client";

import { useEffect, useMemo, useState } from "react";
import { fingerprint } from "../domain/fingerprint";
import { applyMapPatch, describePatch } from "../domain/map-patch";
import { setWcbcOutcome } from "../domain/operations";
import {
  FINDING_LABEL,
  buildReviewPatch,
  type AgentFinding,
  type AgentFindingKind,
  type Finding,
  type NarrativeReview,
} from "../domain/review";
import type { ProductDocument, WcbcOutcome } from "../domain/schema";
import type { ValidationIssue } from "../domain/validate";

type ReviewAnswer = { review?: NarrativeReview; issues?: ValidationIssue[] };
type AcceptAnswer = { product?: ProductDocument; issues?: ValidationIssue[] };

const KIND_LABEL: Record<AgentFindingKind, string> = {
  missing_transition: "Missing transition",
  missing_wcbc: "Missing worst case",
  conflicting_descriptions: "Conflicting descriptions",
  implementation_wording: "Implementation wording",
  missing_product_question: "Missing product question",
};

async function post<T>(url: string, body?: unknown): Promise<T | { issues: ValidationIssue[] }> {
  try {
    const response = await fetch(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
    return (await response.json()) as T;
  } catch (error) {
    return { issues: [{ code: "request_failed", path: url, message: error instanceof Error ? error.message : String(error) }] };
  }
}

/** Lets a human say where a worst case leads. Saving is an ordinary, explicit edit of the map. */
function OutcomeForm({
  product,
  wcbcId,
  onSave,
}: {
  product: ProductDocument;
  wcbcId: string;
  onSave: (outcome: WcbcOutcome) => void;
}) {
  const [kind, setKind] = useState<WcbcOutcome["kind"]>("recovery");
  const [target, setTarget] = useState("");
  const options =
    kind === "recovery"
      ? [...product.narrative].sort((a, b) => a.sequence - b.sequence).map((s) => ({ id: s.id, label: `${s.sequence}. ${s.title}` }))
      : kind === "escalation"
        ? product.personas.map((e) => ({ id: e.id, label: e.name }))
        : [];
  const chosen = options.some((o) => o.id === target) ? target : (options[0]?.id ?? "");

  return (
    <form
      className="row outcome-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (kind === "recovery") onSave({ kind, resumeStepId: chosen });
        else if (kind === "escalation") onSave({ kind, toPersonaId: chosen });
        else onSave({ kind });
      }}
    >
      <span className="muted">Leads to</span>
      <select aria-label={`Outcome kind for ${wcbcId}`} value={kind} onChange={(event) => setKind(event.target.value as WcbcOutcome["kind"])}>
        <option value="recovery">recovery: back to step</option>
        <option value="escalation">escalation: to persona</option>
        <option value="termination">termination: path ends</option>
      </select>
      {options.length > 0 && (
        <select aria-label={`Outcome target for ${wcbcId}`} value={chosen} onChange={(event) => setTarget(event.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <button type="submit" className="secondary" data-testid={`outcome-save-${wcbcId}`}>
        Set outcome
      </button>
    </form>
  );
}

/**
 * Review mode: the findings inbox. Deterministic findings are computed from
 * the map on every render. Agent findings arrive on request and live only in
 * this component until a human accepts some of them.
 */
export function ReviewPanel({
  product,
  findings,
  onAccepted,
  onApply,
}: {
  product: ProductDocument;
  findings: Finding[];
  onAccepted: (product: ProductDocument) => void;
  onApply: (operation: (current: ProductDocument) => ProductDocument) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<NarrativeReview | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  // The status line describes one revision; it is shown only while the map is still that revision.
  const [status, setStatus] = useState<{ text: string; revision: ProductDocument["revision"] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Agent findings are bound to the map they were made on.
  const mapFingerprint = useMemo(() => fingerprint(product), [product]);
  useEffect(() => {
    setReview(null);
    setSelected(new Set());
    setDismissed(new Set());
    setIssues([]);
  }, [mapFingerprint]);

  const entries = useMemo(() => {
    if (!review) return new Map<string, ReturnType<typeof describePatch>[number]>();
    const all = buildReviewPatch(review, review.findings.map((f) => f.findingId));
    return new Map(describePatch(product, all).map((entry) => [entry.opId, entry]));
  }, [product, review]);
  const patch = useMemo(() => (review ? buildReviewPatch(review, [...selected]) : null), [review, selected]);
  const dryRun = useMemo(
    () => (patch && patch.operations.length > 0 ? applyMapPatch(product, patch) : null),
    [product, patch],
  );

  async function run() {
    setBusy(true);
    setStatus(null);
    const answer = (await post<ReviewAnswer>("/api/review")) as ReviewAnswer;
    setBusy(false);
    if (!answer.review) {
      setIssues(answer.issues ?? [{ code: "unknown_error", path: "/api/review", message: "request failed" }]);
      return;
    }
    setIssues([]);
    setSelected(new Set());
    setDismissed(new Set());
    setReview(answer.review);
  }

  async function accept() {
    if (!patch) return;
    setBusy(true);
    const count = patch.operations.length;
    const answer = (await post<AcceptAnswer>("/api/proposal/accept", { patch })) as AcceptAnswer;
    setBusy(false);
    if (!answer.product) {
      setIssues(answer.issues ?? [{ code: "unknown_error", path: "/api/proposal/accept", message: "request failed" }]);
      return;
    }
    setStatus({
      text: `${count} finding${count === 1 ? "" : "s"} accepted. The map is now proposed revision ${answer.product.revision.number} and needs approval again.`,
      revision: answer.product.revision,
    });
    onAccepted(answer.product);
  }

  function toggle(findingId: string) {
    const next = new Set(selected);
    if (next.has(findingId)) next.delete(findingId);
    else next.add(findingId);
    setSelected(next);
  }

  function dismiss(findingId: string) {
    setDismissed(new Set(dismissed).add(findingId));
    const next = new Set(selected);
    next.delete(findingId);
    setSelected(next);
  }

  const visible = review?.findings.filter((f) => !dismissed.has(f.findingId)) ?? [];
  const suggestions = visible.filter((f) => f.operation.op === "add_wcbc");
  const others = visible.filter((f) => f.operation.op !== "add_wcbc");
  const shownIssues = issues.length > 0 ? issues : dryRun && !dryRun.ok ? dryRun.issues : [];

  const agentItem = (finding: AgentFinding) => {
    const entry = entries.get(finding.operation.opId);
    return (
      <li
        key={finding.findingId}
        className={`finding agent ${selected.has(finding.findingId) ? "selected" : ""}`}
        data-testid={`agent-finding-${finding.findingId}`}
        data-kind={finding.kind}
        data-origin={finding.origin}
      >
        <label className="row">
          <input
            type="checkbox"
            checked={selected.has(finding.findingId)}
            aria-label={`Accept ${finding.findingId}`}
            onChange={() => toggle(finding.findingId)}
          />
          <span className="tag">{KIND_LABEL[finding.kind]}</span>
          <span className={`tag ${finding.origin === "NEW_PROPOSAL" ? "new-proposal" : ""}`}>
            {finding.origin === "NEW_PROPOSAL" ? "NEW_PROPOSAL" : "existing ids"}
          </span>
        </label>
        <p>{finding.message}</p>
        {entry && (
          <p className="after">
            If accepted: {entry.headline}
            {entry.after ? ` — ${entry.after}` : ""}
          </p>
        )}
        <p className="muted">
          Relates to:{" "}
          {finding.relatesTo.length > 0 ? finding.relatesTo.map((id) => <code key={id}>{id} </code>) : "nothing on the map yet"}
        </p>
        <blockquote className="source">
          “{finding.operation.source.snippet}”
          <footer>
            {finding.operation.source.rationale}{" "}
            <span className="muted">· confidence {finding.operation.source.confidence.toFixed(2)} (advisory only)</span>
          </footer>
        </blockquote>
        <button type="button" className="link" onClick={() => dismiss(finding.findingId)}>
          Dismiss
        </button>
      </li>
    );
  };

  return (
    <section className="panel review" aria-label="Narrative review" data-testid="review-panel">
      <h2>
        Findings inbox{" "}
        <span className="muted" data-testid="finding-count">
          {findings.length} from fixed checks
        </span>
      </h2>
      <p className="muted">
        Findings are derived from the map and are not stored. A finding never changes the map by itself: you edit the
        map, or you accept an agent finding, which creates a new proposed revision.
      </p>

      <ul className="findings" data-testid="deterministic-findings">
        {findings.length === 0 && <li className="muted">The fixed checks found nothing.</li>}
        {findings.map((finding) => (
          <li key={finding.id} className={`finding ${finding.level}`} data-testid={`finding-${finding.id}`} data-code={finding.code}>
            <span className={`tag ${finding.level}`} data-testid={`finding-label-${finding.id}`}>
              {FINDING_LABEL[finding.code]}
            </span>{" "}
            {finding.message}{" "}
            {finding.relatesTo.map((id) => (
              <code key={id}>{id} </code>
            ))}
            {finding.code === "wcbc_without_outcome" && (
              <OutcomeForm
                product={product}
                wcbcId={finding.relatesTo[0]}
                onSave={(outcome) => void onApply((current) => setWcbcOutcome(current, finding.relatesTo[0], outcome))}
              />
            )}
          </li>
        ))}
      </ul>

      <h2>Agent review</h2>
      <p className="muted">
        Missing transitions between steps, missing worst cases, contradictions, implementation wording and missing product questions are
        looked for by the agent review, on request only. Its findings are proposals: nothing is selected or accepted for you.
      </p>
      <div className="row actions">
        <button type="button" data-testid="agent-review-button" disabled={busy} onClick={() => void run()}>
          {busy ? "Reviewing…" : review ? "Run agent review again" : "Run agent review"}
        </button>
        {review && (
          <span className="muted" data-testid="agent-review-summary">
            {review.provider}: {review.summary}
          </span>
        )}
        {status && status.revision.number === product.revision.number && status.revision.status === product.revision.status && (
          <span className="muted" data-testid="review-status">
            {status.text}
          </span>
        )}
      </div>

      {review && (
        <>
          <h3 className="subhead">Findings</h3>
          <ul className="findings" data-testid="agent-findings">
            {others.length === 0 && <li className="muted">No findings.</li>}
            {others.map(agentItem)}
          </ul>

          <h3 className="subhead">WCBC suggestions</h3>
          <ul className="findings" data-testid="wcbc-suggestions">
            {suggestions.length === 0 && <li className="muted">No suggestions.</li>}
            {suggestions.map(agentItem)}
          </ul>

          <div className="row actions">
            <button type="button" data-testid="review-accept" disabled={busy || !dryRun?.ok} onClick={() => void accept()}>
              Accept {selected.size} selected
            </button>
            <span className="muted">
              Nothing is selected for you. Accepting creates proposed revision {product.revision.number + 1}; it does not
              approve it.
            </span>
          </div>
        </>
      )}

      {shownIssues.length > 0 && (
        <div className="panel error" role="alert" data-testid="review-issues">
          <strong>{review ? "The selected findings cannot be accepted as they stand." : "No agent review."}</strong>
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
