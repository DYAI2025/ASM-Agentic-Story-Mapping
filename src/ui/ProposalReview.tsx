"use client";

import { EDITABLE_OP_FIELDS, type MapPatch, type PatchOperation } from "../domain/map-patch";
import { goalChoice, groupProposal, suggestionsFor } from "../domain/proposal-view";
import type { ProductDocument } from "../domain/schema";

/**
 * The proposal as the human reviews it: grouped into product meaning, each
 * item used, edited or rejected on its own, the source behind a disclosure.
 * A goal offered in several readings is a choice with nothing chosen until
 * the human chooses. Everything here is draft state in the browser; the
 * patch is written only by the accept route, by the human's click.
 */
export function ProposalReview({
  product,
  patch,
  excluded,
  editing,
  onToggle,
  onChooseGoal,
  onEdit,
  onEditToggle,
}: {
  product: ProductDocument;
  patch: MapPatch;
  /** Op ids the human rejected (or, for goals, did not choose). */
  excluded: Set<string>;
  /** Op ids whose fields are open for editing. */
  editing: Set<string>;
  onToggle: (opId: string) => void;
  onChooseGoal: (opId: string) => void;
  onEdit: (opId: string, field: string, value: string) => void;
  onEditToggle: (opId: string) => void;
}) {
  const sections = groupProposal(product, patch);
  const choice = goalChoice(patch);
  const choiceIds = new Set(choice.map((g) => g.opId));
  const operations = new Map(patch.operations.map((o) => [o.opId, o]));

  const fields = (operation: PatchOperation) =>
    EDITABLE_OP_FIELDS[operation.op].map((field) => (
      <label key={field} className="field">
        <span>{field}</span>
        <textarea
          name={`${operation.opId}-${field}`}
          rows={2}
          value={String((operation as Record<string, unknown>)[field] ?? "")}
          onChange={(event) => onEdit(operation.opId, field, event.target.value)}
        />
        <span className="chips" aria-label={`Suggestions for ${field}`}>
          {suggestionsFor(patch, operation, field).map((suggestion, i) => (
            <button
              key={i}
              type="button"
              className="chip"
              data-testid={`chip-${operation.opId}-${field}-${i}`}
              onClick={() => onEdit(operation.opId, field, suggestion.text)}
            >
              {suggestion.label}: {suggestion.text}
            </button>
          ))}
        </span>
      </label>
    ));

  return (
    <div className="proposal-sections">
      {sections.map((section) => (
        <section key={section.group} className={`proposal-section ${section.group}`} data-testid={`proposal-section-${section.group}`}>
          <h3>
            {section.title} <span className="muted">{section.lead}</span>
          </h3>

          {section.group === "goal" && choice.length > 1 && (
            <fieldset className="goal-choice" data-testid="goal-choice">
              <legend>
                The text supports {choice.length} readings of what the product is for. Pick one; ASM does not choose for you.
              </legend>
              {choice.map((goal) => {
                const operation = operations.get(goal.opId)!;
                const chosen = !excluded.has(goal.opId);
                return (
                  <div key={goal.opId} className={`diff-entry set_goal ${chosen ? "" : "excluded"}`} data-testid={`diff-${goal.opId}`} data-op="set_goal" data-state={chosen ? "used" : "open"}>
                    <label className="row">
                      <input type="radio" name="goal-choice" aria-label={`Choose ${goal.opId}`} checked={chosen} onChange={() => onChooseGoal(goal.opId)} />
                      <strong>{goal.statement}</strong>
                    </label>
                    {editing.has(goal.opId) ? fields(operation) : null}
                    <ItemActions opId={goal.opId} editing={editing.has(goal.opId)} onEditToggle={onEditToggle} />
                    <Source operation={operation} />
                  </div>
                );
              })}
            </fieldset>
          )}

          <ol className="diff">
            {section.entries
              .filter((entry) => !choiceIds.has(entry.opId))
              .map((entry) => {
                const operation = operations.get(entry.opId)!;
                const included = !excluded.has(entry.opId);
                return (
                  <li
                    key={entry.opId}
                    className={`diff-entry ${entry.op} ${included ? "" : "excluded"}`}
                    data-testid={`diff-${entry.opId}`}
                    data-op={entry.op}
                    data-state={included ? "used" : "rejected"}
                  >
                    <label className="row">
                      <input type="checkbox" checked={included} aria-label={`Include ${entry.opId}`} onChange={() => onToggle(entry.opId)} />
                      <span className="use">{included ? "Use" : "Rejected"}</span>
                      <strong>{entry.headline}</strong>
                    </label>
                    {editing.has(entry.opId) && included ? (
                      fields(operation)
                    ) : (
                      <>
                        {entry.before !== undefined && <p className="before">− {entry.before}</p>}
                        {entry.after && <p className="after">+ {entry.after}</p>}
                      </>
                    )}
                    {included && <ItemActions opId={entry.opId} editing={editing.has(entry.opId)} onEditToggle={onEditToggle} />}
                    <Source operation={operation} />
                  </li>
                );
              })}
          </ol>
        </section>
      ))}
    </div>
  );
}

function ItemActions({ opId, editing, onEditToggle }: { opId: string; editing: boolean; onEditToggle: (opId: string) => void }) {
  return (
    <div className="row item-actions">
      <button type="button" className="link" data-testid={`edit-${opId}`} onClick={() => onEditToggle(opId)}>
        {editing ? "Done" : "Edit"}
      </button>
    </div>
  );
}

/** Where an item comes from, on demand: the source, the confidence, the rationale, the quote. */
function Source({ operation }: { operation: PatchOperation }) {
  const { source } = operation;
  return (
    <details className="source" data-testid={`source-${operation.opId}`}>
      <summary>
        Source: <span data-testid={`source-of-${operation.opId}`}>{source.sourceLabel ?? "the text"}</span> · confidence {source.confidence.toFixed(2)}
      </summary>
      <blockquote>
        “{source.snippet}”
        <footer>
          {source.rationale} <span className="muted">· confidence is advisory only</span>
        </footer>
      </blockquote>
    </details>
  );
}
