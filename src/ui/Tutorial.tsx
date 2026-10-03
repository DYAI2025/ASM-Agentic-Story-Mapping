"use client";

import { useEffect, useRef, useState } from "react";

/**
 * How ASM is used, in four steps. Shown on a viewer's first visit, skippable,
 * replayable. The only state it has is whether this browser has seen it
 * (`localStorage`, `asm.tutorial`). It imports nothing from the domain and
 * talks to no route: where the product stands is the Product Flow's job,
 * read from the map and the work state; this is not that.
 */
export const TUTORIAL_STEPS: ReadonlyArray<{ title: string; text: string }> = [
  { title: "Bring what you already have", text: "Paste notes, a meeting transcript, a product description or rough thoughts." },
  { title: "Review, don't rewrite", text: "ASM extracts Goals, People, Needs and a Product Journey. You decide what is true." },
  { title: "Check the story", text: "ASM surfaces missing steps, open questions and worst cases." },
  { title: "Turn understanding into work", text: "Approve the Narrative, compare first Slices and create a Work Order." },
];

/** Browser storage key: "done" once this viewer finished or skipped the tutorial. Never product or work state. */
const TUTORIAL_PREFERENCE = "asm.tutorial";

/** One step of the tutorial, as a labelled, non-modal dialog. */
export function TutorialCard({
  step,
  onNext,
  onBack,
  onSkip,
  onFinish,
}: {
  step: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onFinish: () => void;
}) {
  const index = Math.min(Math.max(step, 1), TUTORIAL_STEPS.length) - 1;
  const last = index === TUTORIAL_STEPS.length - 1;
  const current = TUTORIAL_STEPS[index];
  return (
    <section
      className="panel tutorial"
      role="dialog"
      aria-labelledby="tutorial-title"
      data-testid="tutorial"
      data-step={index + 1}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") onSkip();
      }}
    >
      <p className="muted tutorial-progress" data-testid="tutorial-progress">
        Step {index + 1} of {TUTORIAL_STEPS.length} · How ASM is used
      </p>
      <h2 id="tutorial-title" data-testid="tutorial-title">
        {current.title}
      </h2>
      <p data-testid="tutorial-text">{current.text}</p>
      <div className="row actions">
        {index > 0 && (
          <button type="button" className="secondary" data-testid="tutorial-back" onClick={onBack}>
            Back
          </button>
        )}
        {last ? (
          <button type="button" data-testid="tutorial-finish" onClick={onFinish}>
            Finish
          </button>
        ) : (
          <>
            <button type="button" data-testid="tutorial-next" onClick={onNext}>
              Next
            </button>
            <button type="button" className="secondary" data-testid="tutorial-skip" onClick={onSkip}>
              Skip the tutorial
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The tutorial on a screen: shown until this browser has finished or skipped
 * it, then a "Show tutorial" button. Decided after mount, so the server
 * render never guesses what this viewer has seen.
 */
export function Tutorial() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(TUTORIAL_PREFERENCE) !== "done") setOpen(true);
    } catch {
      // No storage: the tutorial shows this once and cannot be remembered.
      setOpen(true);
    }
  }, []);
  // Focus lands in the dialog when it opens, so the keyboard reaches its buttons and Escape.
  useEffect(() => {
    if (open) card.current?.querySelector<HTMLElement>("[data-testid='tutorial']")?.focus();
  }, [open, step]);

  function close() {
    setOpen(false);
    setStep(1);
    try {
      window.localStorage.setItem(TUTORIAL_PREFERENCE, "done");
    } catch {
      // No storage: it will show again next time.
    }
  }

  if (!open)
    return (
      <div className="row tutorial-replay">
        <button
          type="button"
          className="link"
          data-testid="tutorial-replay"
          onClick={() => {
            setStep(1);
            setOpen(true);
          }}
        >
          Show tutorial
        </button>
      </div>
    );
  return (
    <div ref={card}>
      <TutorialCard step={step} onNext={() => setStep(step + 1)} onBack={() => setStep(step - 1)} onSkip={close} onFinish={close} />
    </div>
  );
}
