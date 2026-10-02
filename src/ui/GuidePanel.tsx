"use client";

import type { GuideAction, GuideState } from "../domain/guide";

const STATUS_LABEL = { done: "done", current: "now", upcoming: "later" } as const;

/**
 * The guide over the expert UI. It shows what `deriveGuide` read from the real
 * state and nothing else: it keeps no progress of its own. Its one button
 * takes the human to the part of the existing UI where the step is done; the
 * step counts as done only when the state says so.
 */
export function GuidePanel({
  guide,
  proposalOpen,
  onAction,
  onHide,
}: {
  guide: GuideState;
  /** A proposal is waiting for accept, edit or reject. Until then nothing else can be done. */
  proposalOpen: boolean;
  onAction: (action: GuideAction | { kind: "focus_proposal" }) => void;
  onHide: () => void;
}) {
  const current = guide.steps.find((s) => s.status === "current");
  const reached = guide.impacts.filter((i) => i.reached);
  const stale = guide.steps.find((s) => s.stale && s.status !== "done");

  return (
    <section className="panel guide" aria-label="Guide" data-testid="guide" data-current-step={guide.currentStepId ?? "complete"}>
      <header className="row guide-head">
        <h2>
          Guide{" "}
          <span className="muted" data-testid="guide-progress">
            {guide.doneCount} of {guide.steps.length} steps done
          </span>
        </h2>
        <button type="button" className="secondary" data-testid="guide-hide" onClick={onHide}>
          Hide guide
        </button>
      </header>

      <ol className="guide-steps">
        {guide.steps.map((step, index) => (
          <li
            key={step.id}
            className={`guide-step ${step.status}`}
            data-testid={`guide-step-${step.id}`}
            data-status={step.status}
            data-stale={step.stale ? "true" : undefined}
            aria-current={step.status === "current" ? "step" : undefined}
          >
            <span className="guide-number">{index + 1}</span>
            <span>
              {step.title} <span className="muted">({STATUS_LABEL[step.status]})</span>
              {step.stale && step.status !== "done" && (
                <span className="badge stale" data-testid={`guide-stale-${step.id}`}>
                  earlier choice is stale
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>

      <div className="guide-now" data-testid="guide-now">
        {current ? (
          <>
            <h3 data-testid="guide-current-title">{current.title}</h3>
            <p>{current.purpose}</p>
          </>
        ) : (
          <>
            <h3 data-testid="guide-current-title">All steps are done</h3>
            <p>Your work order is ready to export. If you change the map, the guide takes you back to the step that has to be redone.</p>
          </>
        )}
        {stale && (
          <p className="guide-stale-note" role="status" data-testid="guide-stale-note">
            <strong>Something you did earlier no longer fits the map.</strong> The slice selected before is stale: {stale.stale}. It is
            kept and shown as stale; nothing was deleted or chosen for you. The guide is back at the earliest step that has to be redone.
          </p>
        )}
        {proposalOpen ? (
          <div className="row">
            <button type="button" id="guide-cta" data-testid="guide-cta" onClick={() => onAction({ kind: "focus_proposal" })}>
              Decide on the open proposal
            </button>
            <span className="muted">A proposal is waiting below. Accept, edit or reject it first; the map does not change until you do.</span>
          </div>
        ) : (
          <div className="row">
            <button
              type="button"
              id="guide-cta"
              data-testid="guide-cta"
              onClick={() => onAction(current ? current.action : { kind: "open_slices", label: "Open the work order" })}
            >
              {current ? current.action.label : "Open the work order"}
            </button>
            <span className="muted">This takes you to the place; the step is done when you have done it there.</span>
          </div>
        )}
      </div>

      {reached.length > 0 && (
        <ul className="guide-impacts" aria-label="What you have so far">
          {reached.map((impact) => (
            <li key={impact.id} data-testid={`impact-${impact.id}`}>
              ✓ {impact.label}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
