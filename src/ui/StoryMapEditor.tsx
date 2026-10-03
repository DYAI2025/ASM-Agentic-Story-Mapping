"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isPersona } from "../domain/actors";
import { fingerprint } from "../domain/fingerprint";
import { deriveGuide, type GuideAction } from "../domain/guide";
import type { Touch } from "../domain/map-patch";
import {
  DomainError,
  EDITABLE_FIELDS,
  moveStep,
  setActorRoles,
  setCardRow,
  setPersonaPerspective,
  updateCard,
  type CardKind,
} from "../domain/operations";
import { buildStoryMap } from "../domain/projection";
import { reviewNarrative } from "../domain/review";
import { MAX_LAYOUT_ROW, type ProductDocument, type Provenance } from "../domain/schema";
import { validateProduct, type ValidationIssue } from "../domain/validate";
import { resolvePersonaCheck, resolveSelection, type PersonaCheck, type SliceSelection } from "../domain/work-state";
import { ActorSemantics } from "./ActorSemantics";
import { GuidePanel } from "./GuidePanel";
import { ReviewPanel } from "./ReviewPanel";
import { SliceDrawer } from "./SliceDrawer";
import { Tutorial } from "./Tutorial";
import { WorkshopPanel, type ProposalPreview } from "./WorkshopPanel";

type ApiResult = { product?: ProductDocument; issues?: ValidationIssue[] };

const KIND_LABEL: Record<CardKind, string> = {
  goal: "Goal",
  persona: "Persona",
  need: "Need",
  step: "Step",
  wcbc: "WCBC",
  decision: "Decision",
};

/** What every card needs to know about the document it is shown in. */
const CardContext = createContext<{
  readOnly: boolean;
  touched: Record<string, Touch>;
  provenance: Provenance[];
  /** Review mode only: how many findings are about each card. */
  findingCounts: Record<string, number>;
}>({ readOnly: false, touched: {}, provenance: [], findingCounts: {} });

const TOUCH_LABEL: Record<Touch, string> = { added: "New", changed: "Changed", moved: "Moved" };

/** Browser storage key for whether this viewer wants the guide shown. Never product or work state. */
const GUIDE_PREFERENCE = "asm.guide";

function EditableCard({
  id,
  kind,
  values,
  className = "",
  onSave,
  children,
}: {
  id: string;
  kind: CardKind;
  values: Record<string, string>;
  className?: string;
  onSave: (id: string, patch: Record<string, string>) => Promise<boolean>;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(values);
  const context = useContext(CardContext);
  const touch = context.touched[id];
  const sources = context.provenance.filter((entry) => entry.targetId === id);
  const findingCount = context.findingCounts[id] ?? 0;

  if (!editing || context.readOnly) {
    return (
      <article
        className={`card ${className} ${touch ? `diff-${touch}` : ""} ${findingCount > 0 ? "has-finding" : ""}`}
        data-testid={`card-${id}`}
        data-kind={kind}
        data-diff={touch}
      >
        {touch && <span className="diff-flag">{TOUCH_LABEL[touch]}</span>}
        {findingCount > 0 && (
          <span className="finding-flag" data-testid={`finding-flag-${id}`}>
            {findingCount} finding{findingCount === 1 ? "" : "s"}
          </span>
        )}
        {children}
        {sources.length > 0 && (
          <details className="provenance" data-testid={`provenance-${id}`}>
            <summary>
              Source ({sources.length})
            </summary>
            {sources.map((entry, i) => (
              <blockquote key={i} className="source">
                “{entry.snippet}”
                <footer>
                  {entry.rationale}{" "}
                  <span className="muted">
                    {entry.sourceLabel && <>· from “{entry.sourceLabel}” </>}· {entry.change} in revision {entry.revision} · {entry.provider} ·
                    confidence {entry.confidence.toFixed(2)} (advisory only)
                  </span>
                </footer>
              </blockquote>
            ))}
          </details>
        )}
        <footer className="card-footer">
          <code className="card-id">{id}</code>
          {!context.readOnly && (
            <button
              type="button"
              className="link"
              aria-label={`Edit ${KIND_LABEL[kind]} ${id}`}
              onClick={() => {
                setDraft(values);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
        </footer>
      </article>
    );
  }

  return (
    <article className={`card editing ${className}`} data-testid={`card-${id}`} data-kind={kind}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (await onSave(id, draft)) setEditing(false);
        }}
      >
        {EDITABLE_FIELDS[kind].map((field) => (
          <label key={field} className="field">
            <span>{field}</span>
            <textarea
              name={field}
              rows={field === "title" || field === "name" ? 2 : 4}
              value={draft[field] ?? ""}
              onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
            />
          </label>
        ))}
        <div className="row">
          <button type="submit">Save</button>
          <button type="button" className="secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </form>
    </article>
  );
}

export function StoryMapEditor({
  initial,
  initialSelection,
  initialPersonaCheck,
}: {
  initial: ProductDocument;
  initialSelection: SliceSelection | null;
  initialPersonaCheck: PersonaCheck | null;
}) {
  const [product, setProduct] = useState(initial);
  // Work state, not part of the product: which slice a human selected.
  const [selection, setSelection] = useState(initialSelection);
  // Work state as well: a human's confirmation that they considered who else is relevant.
  const [personaCheck, setPersonaCheck] = useState(initialPersonaCheck);
  const [personaFilter, setPersonaFilter] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [approver, setApprover] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  // A proposal under review. `preview` is what the map would become; the
  // canonical `product` stays untouched until the proposal is accepted.
  const [preview, setPreview] = useState<ProposalPreview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [slicesOpen, setSlicesOpen] = useState(false);
  // Start over: a destructive action behind its own confirmation. "asking" shows it; "busy" is the request in flight.
  const [startOver, setStartOver] = useState<"closed" | "asking" | "busy">("closed");
  const shown = preview?.product ?? product;
  const findings = useMemo(() => reviewNarrative(product), [product]);
  // A selection counts only while it still matches this exact map; otherwise it is stale: shown as stale, never as selected.
  const selectedCandidate = useMemo(() => {
    const resolved = selection ? resolveSelection(product, selection) : null;
    return resolved?.ok ? resolved.candidate : null;
  }, [product, selection]);
  const selectionStale = selection !== null && selectedCandidate === null;
  const personaCheckStale = personaCheck !== null && !resolvePersonaCheck(product, personaCheck).ok;
  const sliceSteps = useMemo(() => new Set(selectedCandidate?.stepIds ?? []), [selectedCandidate]);

  const view = useMemo(() => buildStoryMap(shown, personaFilter), [shown, personaFilter]);
  const cardContext = useMemo(() => {
    const findingCounts: Record<string, number> = {};
    if (reviewMode && !reviewing)
      for (const finding of findings) {
        const target = finding.relatesTo[0];
        if (target) findingCounts[target] = (findingCounts[target] ?? 0) + 1;
      }
    return { readOnly: reviewing, touched: preview?.touched ?? {}, provenance: shown.provenance, findingCounts };
  }, [reviewing, reviewMode, findings, preview, shown]);
  const validation = useMemo(() => validateProduct(product), [product]);
  const approved = product.revision.status === "approved";

  // The guide is read from the product and the work state. Whether it is shown is view state only.
  const guide = useMemo(() => deriveGuide(product, selection, personaCheck), [product, selection, personaCheck]);
  const [guideOn, setGuideOn] = useState(true);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  // The server cannot know the preference; layout.tsx hides the panel by CSS until this has run.
  useLayoutEffect(() => {
    try {
      if (window.localStorage.getItem(GUIDE_PREFERENCE) === "off") setGuideOn(false);
    } catch {
      // No storage: the guide stays on.
    }
  }, []);
  // Focus moves after the part of the UI the guide points at has been rendered.
  useEffect(() => {
    if (!focusTarget) return;
    const target = document.getElementById(focusTarget);
    target?.scrollIntoView({ block: "center" });
    target?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  function showGuide(on: boolean) {
    setGuideOn(on);
    try {
      window.localStorage.setItem(GUIDE_PREFERENCE, on ? "on" : "off");
    } catch {
      // No storage: the choice lasts until the page is reloaded.
    }
    if (on) delete document.documentElement.dataset.guide;
    else document.documentElement.dataset.guide = "off";
    setFocusTarget(on ? "guide-cta" : "guide-show");
  }

  /** Takes the human to where the step is done. Opens and focuses; never writes. */
  function follow(action: GuideAction | { kind: "focus_proposal" }) {
    if (action.kind === "focus_proposal") setFocusTarget("proposal-review");
    else if (action.kind === "focus_workshop") setFocusTarget("workshop-input");
    else if (action.kind === "focus_approval") {
      setReviewMode(true);
      setFocusTarget("approver-name");
    } else {
      setSlicesOpen(true);
      setFocusTarget("slice-drawer");
    }
  }

  async function send(url: string, method: string, body: string, headers?: Record<string, string>): Promise<boolean> {
    let result: ApiResult;
    try {
      const response = await fetch(url, { method, body, headers });
      result = (await response.json()) as ApiResult;
    } catch (error) {
      setIssues([
        { code: "request_failed", path: url, message: error instanceof Error ? error.message : String(error) },
      ]);
      return false;
    }
    if (!result.product) {
      setIssues(result.issues ?? [{ code: "unknown_error", path: url, message: "request failed" }]);
      return false;
    }
    setProduct(result.product);
    setIssues([]);
    return true;
  }

  async function apply(operation: (current: ProductDocument) => ProductDocument): Promise<boolean> {
    let next: ProductDocument;
    try {
      next = operation(product);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      setIssues([{ code: "operation_rejected", path: "(editor)", message: error.message }]);
      return false;
    }
    // The save names the map as this page shows it; the server refuses it if the map moved meanwhile.
    return send("/api/product", "PUT", JSON.stringify(next), { "if-match": `"${fingerprint(product)}"` });
  }

  const saveCard = (id: string, patch: Record<string, string>) =>
    apply((current) => updateCard(current, id, patch));

  /**
   * The confirmed reset. On success the page reloads from the server, which
   * finds no product and shows the start screen; on failure the map stays, with
   * the reason shown. Nothing here pretends a fresh state the server does not have.
   */
  async function confirmStartOver() {
    setStartOver("busy");
    let result: { ok?: boolean; issues?: ValidationIssue[] };
    try {
      // The confirmation names the product as this page shows it; a different one on disk is not removed.
      const response = await fetch("/api/product/reset", {
        method: "POST",
        body: JSON.stringify({ confirm: "start over", productId: product.product.id, mapFingerprint: fingerprint(product) }),
      });
      result = (await response.json()) as typeof result;
    } catch (error) {
      result = { issues: [{ code: "request_failed", path: "/api/product/reset", message: error instanceof Error ? error.message : String(error) }] };
    }
    if (result.ok) {
      window.location.assign("/");
      return;
    }
    setIssues(result.issues ?? [{ code: "unknown_error", path: "/api/product/reset", message: "request failed" }]);
    setStartOver("closed");
  }

  return (
    <CardContext.Provider value={cardContext}>
    <main className="page">
      <header className="topbar">
        <div>
          <h1 data-testid="product-name">{product.product.name}</h1>
          <p className="muted">{product.product.summary}</p>
        </div>
        <div className="revision">
          <span className="muted">Revision {product.revision.number}</span>
          <span className={`badge ${product.revision.status}`} data-testid="revision-status">
            {product.revision.status}
          </span>
          {approved && product.revision.approval ? (
            <span className="muted" data-testid="approval-record">
              by {product.revision.approval.approvedBy} · {product.revision.approval.approvedAt}
            </span>
          ) : (
            <form
              className="row"
              onSubmit={(event) => {
                event.preventDefault();
                // The approval is of the map as shown; the server refuses it if the map moved meanwhile.
                void send("/api/product/approve", "POST", JSON.stringify({ approvedBy: approver, mapFingerprint: fingerprint(product) }));
              }}
            >
              <input
                id="approver-name"
                aria-label="Approver name"
                placeholder="Your name"
                value={approver}
                onChange={(event) => setApprover(event.target.value)}
              />
              <button type="submit" data-testid="approve-button" disabled={reviewing}>
                Approve revision
              </button>
            </form>
          )}
        </div>
      </header>

      <Tutorial />

      {guideOn && <GuidePanel guide={guide} proposalOpen={reviewing} onAction={follow} onHide={() => showGuide(false)} />}

      <section className="toolbar">
        <label className="row">
          <span>Person</span>
          <select
            data-testid="persona-filter"
            value={personaFilter ?? ""}
            onChange={(event) => setPersonaFilter(event.target.value || null)}
          >
            <option value="">Everyone</option>
            {shown.personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          {!guideOn && (
            <button type="button" id="guide-show" className="secondary" data-testid="guide-show" onClick={() => showGuide(true)}>
              Show product flow
            </button>
          )}
          <button
            type="button"
            className={reviewMode ? "" : "secondary"}
            data-testid="review-toggle"
            aria-pressed={reviewMode}
            disabled={reviewing}
            onClick={() => setReviewMode(!reviewMode)}
          >
            {reviewMode ? "Leave review mode" : "Review mode"}
          </button>
          <button
            type="button"
            className="secondary"
            data-testid="slices-open"
            disabled={reviewing}
            onClick={() => setSlicesOpen(true)}
          >
            Slices
          </button>
          {selectedCandidate && (
            <span className="badge approved" data-testid="selected-slice-badge">
              Slice: {selectedCandidate.title}
            </span>
          )}
          {selectionStale && (
            <span className="badge stale" data-testid="stale-slice-badge">
              Slice selection stale
            </span>
          )}
          {personaCheckStale && (
            <span className="badge stale" data-testid="stale-people-check-badge">
              People check stale
            </span>
          )}
        </div>
        <div className="row">
          <a className="button secondary" href="/api/product?format=yaml" data-testid="export-yaml">
            Export YAML
          </a>
          <a className="button secondary" href="/api/product?format=json" data-testid="export-json">
            Export JSON
          </a>
          <button
            type="button"
            className="secondary"
            disabled={reviewing}
            onClick={() => fileInput.current?.click()}
          >
            Import file…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".yaml,.yml,.json"
            hidden
            data-testid="import-input"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) await send("/api/product/import", "POST", await file.text());
            }}
          />
          <button
            type="button"
            className="secondary danger"
            data-testid="start-over"
            disabled={reviewing || startOver !== "closed"}
            onClick={() => setStartOver("asking")}
          >
            Start over…
          </button>
        </div>
      </section>

      {startOver !== "closed" && (
        <section className="panel danger" role="dialog" aria-labelledby="start-over-title" data-testid="start-over-dialog">
          <h2 id="start-over-title">Start over?</h2>
          <p>
            This removes the product “{product.product.name}” and everything decided on it here: its approval, the people check, the slice
            selection and any work order. You get the empty start screen back. There is no undo; export the YAML first if you want to keep it.
          </p>
          <div className="row actions">
            <button type="button" className="danger" data-testid="start-over-confirm" disabled={startOver === "busy"} onClick={() => void confirmStartOver()}>
              {startOver === "busy" ? "Removing…" : "Yes, start over"}
            </button>
            <button type="button" className="secondary" data-testid="start-over-cancel" disabled={startOver === "busy"} onClick={() => setStartOver("closed")}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {(selectionStale || personaCheckStale) && (
        <p className="stale-summary" role="status" data-testid="stale-summary">
          <strong>
            {personaCheckStale && selectionStale
              ? "A stored confirmation and a stored slice selection no longer fit this map."
              : personaCheckStale
                ? "A stored confirmation no longer fits this map."
                : "A stored slice selection no longer fits this map."}
          </strong>{" "}
          {personaCheckStale && selectionStale
            ? "Both are kept and shown as stale; nothing is confirmed or chosen for you."
            : personaCheckStale
              ? "It is kept and shown as stale; nothing is confirmed for you."
              : "It is kept and shown as stale; nothing is chosen for you."}{" "}
          {/* The way back is what the guide derives: the earliest step the state has not reached. */}
          The way back starts at “{guide.steps.find((s) => s.id === guide.currentStepId)?.title ?? "Export the work order"}”
          {guide.steps.filter((s) => s.stale && s.status !== "done" && s.id !== guide.currentStepId).length > 0
            ? `; still to redo after that: ${guide.steps
                .filter((s) => s.stale && s.status !== "done" && s.id !== guide.currentStepId)
                .map((s) => `“${s.title}”`)
                .join(", ")}`
            : ""}
          .
        </p>
      )}

      <WorkshopPanel
        product={product}
        onPreview={setPreview}
        onReviewing={setReviewing}
        onAccepted={(next) => {
          setProduct(next);
          setIssues([]);
        }}
      />

      {reviewMode && !reviewing && (
        <ReviewPanel
          product={product}
          findings={findings}
          onApply={apply}
          onAccepted={(next) => {
            setProduct(next);
            setIssues([]);
          }}
        />
      )}

      {slicesOpen && !reviewing && (
        <SliceDrawer
          product={product}
          selection={selection}
          personaCheck={personaCheck}
          onPersonaCheck={(next) => {
            setPersonaCheck(next);
            setIssues([]);
          }}
          onClose={() => setSlicesOpen(false)}
          onSelection={(next) => {
            setSelection(next);
            setIssues([]);
          }}
        />
      )}

      {reviewing && (
        <p className="preview-banner" data-testid="preview-banner">
          {preview
            ? "Previewing the proposal on the map below. Highlighted cards are new, changed or moved. Nothing is saved until you accept."
            : "The proposal as edited is not valid, so the map below shows the current state."}
        </p>
      )}

      {issues.length > 0 && (
        <section className="panel error" role="alert" data-testid="issues">
          <strong>Not saved.</strong>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>
                <code>{issue.path}</code> — {issue.message} <small>({issue.code})</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Product goal">
        <h2>Product goal</h2>
        <EditableCard
          id={shown.goal.id}
          kind="goal"
          className="goal"
          values={{ statement: shown.goal.statement }}
          onSave={saveCard}
        >
          <p className="goal-statement" data-testid="goal-statement">
            {shown.goal.statement}
          </p>
        </EditableCard>
      </section>

      <section aria-label="People">
        <h2>
          People <span className="muted">who is involved, in what role, and whose needs the narrative models (personas)</span>
        </h2>
        <div className="grid">
          {shown.personas.map((persona) => (
            <EditableCard
              key={persona.id}
              id={persona.id}
              kind="persona"
              className={personaFilter && personaFilter !== persona.id ? "dimmed" : ""}
              values={{ name: persona.name, description: persona.description }}
              onSave={saveCard}
            >
              <h3>{persona.name}</h3>
              <p>{persona.description}</p>
              <ActorSemantics
                actor={persona}
                needCount={shown.needs.filter((need) => need.personaId === persona.id).length}
                readOnly={reviewing}
                onSave={(roles, asPersona) =>
                  // One save: both statements change together or not at all. The persona answer is
                  // written only when the human changed it, so saving roles adds nothing else to the map.
                  apply((current) => {
                    const next = setActorRoles(current, persona.id, roles);
                    return isPersona(persona) === asPersona ? next : setPersonaPerspective(next, persona.id, asPersona);
                  })
                }
              />
              <ul className="needs">
                {shown.needs
                  .filter((need) => need.personaId === persona.id)
                  .map((need) => (
                    <li key={need.id}>{need.statement}</li>
                  ))}
              </ul>
            </EditableCard>
          ))}
        </div>
      </section>

      <section aria-label="Story map">
        <h2>
          Main narrative <span className="muted">→ in sequence; WCBC branches hang below each step</span>
        </h2>
        <div className="map" data-testid="story-map">
          {view.columns.map((column, index) => (
            <div
              key={column.step.id}
              className={`column ${column.inFocus ? "" : "dimmed"} ${sliceSteps.has(column.step.id) ? "in-slice" : ""}`}
              data-testid={`column-${column.step.id}`}
              data-in-slice={sliceSteps.has(column.step.id)}
              data-in-focus={column.inFocus}
              style={{ paddingTop: column.row * 28 }}
            >
              <EditableCard
                id={column.step.id}
                kind="step"
                className="step"
                values={{ title: column.step.title, description: column.step.description }}
                onSave={saveCard}
              >
                <span className="sequence">{column.step.sequence}</span>
                <h3>{column.step.title}</h3>
                <p>{column.step.description}</p>
                <div className="chips">
                  {column.personas.map((persona) => (
                    <span key={persona.id} className="chip">
                      {persona.name}
                    </span>
                  ))}
                </div>
                <div className="controls">
                  <span title="Changes the narrative order (semantic)">
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Move ${column.step.id} earlier in narrative`}
                      disabled={reviewing || index === 0}
                      onClick={() => void apply((current) => moveStep(current, column.step.id, -1))}
                    >
                      ◀
                    </button>
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Move ${column.step.id} later in narrative`}
                      disabled={reviewing || index === view.columns.length - 1}
                      onClick={() => void apply((current) => moveStep(current, column.step.id, 1))}
                    >
                      ▶
                    </button>
                  </span>
                  <span title="Changes only where the card sits (visual, no meaning)">
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Nudge ${column.step.id} up visually`}
                      disabled={reviewing || column.row === 0}
                      onClick={() =>
                        void apply((current) => setCardRow(current, column.step.id, column.row - 1))
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Nudge ${column.step.id} down visually`}
                      disabled={reviewing || column.row === MAX_LAYOUT_ROW}
                      onClick={() =>
                        void apply((current) => setCardRow(current, column.step.id, column.row + 1))
                      }
                    >
                      ↓
                    </button>
                  </span>
                </div>
              </EditableCard>

              {column.branches.map((branch) => (
                <div key={branch.id} className="branch">
                  <EditableCard
                    id={branch.id}
                    kind="wcbc"
                    className={`wcbc ${branch.kind}`}
                    values={{
                      title: branch.title,
                      description: branch.description,
                      recovery: branch.recovery,
                    }}
                    onSave={saveCard}
                  >
                    <span className="kind">{branch.kind === "worst_case" ? "Worst case" : "Best case"}</span>
                    <h4>{branch.title}</h4>
                    <p>{branch.description}</p>
                    {branch.recovery && (
                      <p className="recovery">
                        <strong>Recovery:</strong> {branch.recovery}
                      </p>
                    )}
                    {branch.outcome && (
                      <p className="outcome" data-testid={`outcome-${branch.id}`}>
                        <strong>Leads to:</strong>{" "}
                        {branch.outcome.kind === "recovery" ? (
                          <>
                            recovery at <code>{branch.outcome.resumeStepId}</code>
                          </>
                        ) : branch.outcome.kind === "escalation" ? (
                          <>
                            escalation to <code>{branch.outcome.toPersonaId}</code>
                          </>
                        ) : (
                          "termination"
                        )}
                      </p>
                    )}
                  </EditableCard>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section aria-label="Decisions">
        <h2>
          Decisions and rationale{" "}
          <span className="muted" data-testid="open-decisions">
            {view.openDecisionCount} open
          </span>
        </h2>
        <div className="grid">
          {view.decisions.map((decision) => (
            <EditableCard
              key={decision.id}
              id={decision.id}
              kind="decision"
              className={`decision ${decision.status}`}
              values={{ title: decision.title, rationale: decision.rationale }}
              onSave={saveCard}
            >
              <span className={`badge ${decision.status}`}>{decision.status}</span>
              <h3>{decision.title}</h3>
              {decision.rationale ? <p>{decision.rationale}</p> : <p className="muted">No rationale yet.</p>}
              <p className="muted">
                Relates to:{" "}
                {decision.relatesTo.map((id) => (
                  <code key={id}>{id} </code>
                ))}
              </p>
            </EditableCard>
          ))}
        </div>
      </section>

      <section className="panel" aria-label="Validation" data-testid="validation">
        <h2>Validation</h2>
        {validation.ok ? (
          <p>Canonical document is valid: all ids are unique and all references resolve.</p>
        ) : (
          <ul>
            {validation.issues.map((issue, i) => (
              <li key={i}>
                <code>{issue.path}</code> — {issue.message}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
    </CardContext.Provider>
  );
}
