"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_SOURCES,
  PASTED_LABEL,
  supportedFileName,
  type ContextBundle,
  type ContextSource,
} from "../domain/context";
import { applyMapPatch, type MapPatch, type PatchOperation, type Touch } from "../domain/map-patch";
import { goalChoice, goalChoiceOpen } from "../domain/proposal-view";
import type { ProductDocument } from "../domain/schema";
import type { ValidationIssue } from "../domain/validate";
import { ProposalReview } from "./ProposalReview";

/**
 * Reads the files the human picked as UTF-8 text. A file that is not a text
 * file, not UTF-8, empty or over the limit is reported, not added. Ids are
 * `src-N` and never reused within one panel, so a removed source cannot be
 * confused with a later one.
 */
async function readFiles(files: File[], nextId: () => string): Promise<{ sources: ContextSource[]; issues: ValidationIssue[] }> {
  const sources: ContextSource[] = [];
  const issues: ValidationIssue[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of files) {
    if (!supportedFileName(file.name)) {
      issues.push({ code: "unsupported_type", path: file.name, message: `"${file.name}" is not a .txt or .md file; only text and markdown files are read` });
      continue;
    }
    if (file.size > MAX_CONTEXT_CHARS * 4) {
      issues.push({ code: "source_too_large", path: file.name, message: `"${file.name}" is too large; the limit is ${MAX_CONTEXT_CHARS} characters per source` });
      continue;
    }
    let text: string;
    try {
      text = decoder.decode(await file.arrayBuffer());
    } catch {
      issues.push({ code: "invalid_text_encoding", path: file.name, message: `"${file.name}" could not be read as UTF-8 text` });
      continue;
    }
    if (text.trim() === "") {
      issues.push({ code: "empty_source", path: file.name, message: `"${file.name}" has no text in it` });
      continue;
    }
    sources.push({ id: nextId(), label: file.name, kind: "file", text });
  }
  return { sources, issues };
}

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
  gate,
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
  /**
   * Asked when the human wants a proposal. A message means: not yet, and
   * why; the caller has already moved the focus to what is missing. The
   * button itself is never disabled for it, so the reason is always readable.
   */
  gate?: () => string | null;
}) {
  const [transcript, setTranscript] = useState("");
  // Files the human added, in the order added. The pasted text is not one of them; it becomes src-1 at send time.
  const [files, setFiles] = useState<ContextSource[]>([]);
  const nextFileId = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [status, setStatus] = useState("");
  const [patch, setPatch] = useState<MapPatch | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Set<string>>(new Set());

  /** What would be sent: the pasted text first, when there is any, then the files. */
  const bundle = useMemo<ContextBundle>(() => {
    const pasted: ContextSource[] = transcript.trim() === "" ? [] : [{ id: "src-1", label: PASTED_LABEL, kind: "pasted", text: transcript }];
    return { sources: [...pasted, ...files] };
  }, [transcript, files]);
  const hasContext = bundle.sources.length > 0;

  const effective = useMemo(
    () => (patch ? { ...patch, operations: patch.operations.filter((o) => !excluded.has(o.opId)) } : null),
    [patch, excluded],
  );
  const result = useMemo(() => (effective ? applyMapPatch(product, effective) : null), [product, effective]);
  // Several goal readings and not exactly one chosen: the decision is the human's and still open, whatever validity says.
  const goalOpen = patch !== null && goalChoiceOpen(patch, excluded);

  useEffect(() => {
    onPreview(result?.ok ? { product: result.product, touched: result.touched } : null);
  }, [result, onPreview]);
  useEffect(() => {
    onReviewing(patch !== null);
  }, [patch, onReviewing]);

  function close(message: string) {
    setPatch(null);
    setExcluded(new Set());
    setEditing(new Set());
    setIssues([]);
    setStatus(message);
  }

  /** Clear input: only what was typed or added here and never sent anywhere. The map is not involved. */
  function clear() {
    setTranscript("");
    setFiles([]);
    close("Input cleared. The map was not changed.");
  }

  async function addFiles(picked: File[]) {
    if (picked.length === 0) return;
    const room = MAX_CONTEXT_SOURCES - 1 - files.length;
    // src-1 is the pasted text; files count up from src-2 and an id is never reused after a removal.
    const { sources, issues: refused } = await readFiles(picked.slice(0, Math.max(room, 0)), () => `src-${(nextFileId.current += 1) + 1}`);
    if (picked.length > room)
      refused.push({ code: "too_many_sources", path: "files", message: `at most ${MAX_CONTEXT_SOURCES - 1} files at a time; ${picked.length - Math.max(room, 0)} not added` });
    setFiles([...files, ...sources]);
    setIssues(refused);
    setStatus("");
  }

  function removeFile(id: string) {
    setFiles(files.filter((source) => source.id !== id));
  }

  async function structure() {
    const why = gate?.() ?? null;
    if (why) {
      setStatus(why);
      return;
    }
    setBusy(true);
    setStatus("");
    const answer = await post(endpoints.propose, { ...extra, context: bundle });
    setBusy(false);
    if (!answer.patch) {
      setIssues(answer.issues ?? [{ code: "unknown_error", path: endpoints.propose, message: "request failed" }]);
      return;
    }
    setIssues([]);
    // A goal offered in several readings starts with none chosen: the human picks, nobody else.
    setExcluded(new Set(goalChoice(answer.patch).map((goal) => goal.opId)));
    setEditing(new Set());
    setPatch(answer.patch);
  }

  async function accept() {
    if (!effective || busy || goalOpen) return;
    setBusy(true);
    // Until the answer is in, nothing about the proposal can change: what was sent is what will land.
    const answer = await post(endpoints.accept, { ...extra, patch: effective });
    setBusy(false);
    if (!answer.product) {
      setIssues(answer.issues ?? [{ code: "unknown_error", path: endpoints.accept, message: "request failed" }]);
      return;
    }
    const revision = answer.product.revision.number;
    onAccepted(answer.product);
    setTranscript("");
    setFiles([]);
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

  /** Exactly one goal of the choice is kept; the others are left out of what is sent. */
  function chooseGoal(opId: string) {
    if (!patch) return;
    const next = new Set(excluded);
    for (const goal of goalChoice(patch)) {
      if (goal.opId === opId) next.delete(goal.opId);
      else next.add(goal.opId);
    }
    setExcluded(next);
  }

  function toggleEditing(opId: string) {
    const next = new Set(editing);
    if (next.has(opId)) next.delete(opId);
    else next.add(opId);
    setEditing(next);
  }

  const shownIssues = issues.length > 0 ? issues : result && !result.ok ? result.issues : [];
  const includedCount = effective?.operations.length ?? 0;

  return (
    <section className="panel workshop" aria-label="Workshop input" data-testid="workshop">
      <h2>{labels?.heading ?? "Workshop input"}</h2>

      {!patch && (
        <>
          <p className="muted" data-testid="intake-intro">
            {labels?.intro ??
              "Paste anything you already have: a product discussion, notes, a workshop transcript. The text is treated as material to analyse, never as instructions. You get a proposal to review; the map does not change until you accept it."}
          </p>
          <textarea
            id="workshop-input"
            data-testid="transcript-input"
            aria-label="Discussion text"
            rows={8}
            placeholder={labels?.placeholder ?? "Paste discussion, notes or transcript…"}
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
          />
          <div className="context-files" data-testid="context-bundle">
            <input
              ref={fileInput}
              type="file"
              accept=".txt,.md"
              multiple
              hidden
              data-testid="context-files"
              aria-label="Text or markdown files"
              onChange={async (event) => {
                // Copied before the input is reset: the FileList is live and empties with it.
                const picked = Array.from(event.target.files ?? []);
                event.target.value = "";
                await addFiles(picked);
              }}
            />
            <button type="button" className="secondary" data-testid="add-files" disabled={busy} onClick={() => fileInput.current?.click()}>
              Add text or markdown files
            </button>
            {files.length > 0 && (
              <ul className="sources" data-testid="context-sources" aria-label="Added files">
                {files.map((source) => (
                  <li key={source.id} data-testid={`context-source-${source.id}`} data-source-id={source.id}>
                    <code>{source.id}</code> <strong>{source.label}</strong>{" "}
                    <span className="muted">{source.text.length.toLocaleString("en")} characters</span>
                    <button type="button" className="link" aria-label={`Remove ${source.label}`} onClick={() => removeFile(source.id)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {hint}
          <div className="row actions">
            <button
              type="button"
              data-testid="structure-button"
              disabled={busy || !hasContext}
              onClick={() => void structure()}
            >
              {busy ? (labels?.busy ?? "Structuring…") : (labels?.button ?? "Structure discussion")}
            </button>
            <button
              type="button"
              className="secondary"
              data-testid="clear-input"
              disabled={busy || (transcript === "" && files.length === 0)}
              onClick={clear}
            >
              Clear input
            </button>
            {status && (
              <span className="muted" data-testid="proposal-status">
                {status}
              </span>
            )}
          </div>
        </>
      )}

      {patch && (
        <div id="proposal-review" tabIndex={-1} data-testid="proposal-review" data-pending={busy ? "true" : "false"}>
          <p>
            <strong>Proposal</strong> <span className="muted">from {patch.provider}</span>
          </p>
          {patch.summary && <p className="muted">{patch.summary}</p>}

          <ProposalReview
            product={product}
            patch={patch}
            excluded={excluded}
            editing={editing}
            onToggle={toggle}
            onChooseGoal={chooseGoal}
            onEdit={editOperation}
            onEditToggle={toggleEditing}
            pending={busy}
          />

          {goalOpen && (
            // Said in words, not only by a disabled button: which decision is missing and that it is the human's.
            <p id="goal-choice-required" className="stale" role="status" data-testid="goal-choice-required">
              Choose exactly one goal reading above to accept this proposal. ASM does not choose one for you, and until you do, Accept is unavailable.
            </p>
          )}

          <div className="row actions">
            <button
              type="button"
              data-testid="proposal-accept"
              disabled={busy || goalOpen || !result?.ok}
              aria-describedby={goalOpen ? "goal-choice-required" : undefined}
              onClick={() => void accept()}
            >
              Accept {includedCount} change{includedCount === 1 ? "" : "s"}
            </button>
            <button
              type="button"
              className="secondary"
              data-testid="proposal-edit"
              disabled={busy}
              onClick={() => setEditing(editing.size > 0 ? new Set() : new Set(patch.operations.map((o) => o.opId)))}
            >
              {editing.size > 0 ? "Done editing" : "Edit all"}
            </button>
            <button
              type="button"
              className="secondary"
              data-testid="proposal-reject"
              disabled={busy}
              onClick={() => close("Proposal rejected. The map was not changed.")}
            >
              Reject
            </button>
            <span className="muted" data-testid="proposal-status" aria-live="polite">
              {busy
                ? "Accepting… the changes as sent are being written; nothing here can change until that is done."
                : (labels?.acceptNote ?? `Accepting creates proposed revision ${product.revision.number + 1}. It does not approve it.`)}
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
