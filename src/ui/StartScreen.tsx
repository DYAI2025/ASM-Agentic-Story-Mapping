"use client";

import { useCallback, useMemo, useState } from "react";
import { ROLE_LABEL, isPersona, rolesOf } from "../domain/actors";
import { MAX_NAME_LENGTH, blankProduct } from "../domain/bootstrap";
import { deriveStartGuide } from "../domain/guide";
import { GuidePanel } from "./GuidePanel";
import { WorkshopPanel, type ProposalPreview } from "./WorkshopPanel";

/**
 * Where a first product starts: there is no product file yet. The human names
 * the product and says, in their own words, what they want to build. That
 * text becomes a proposal through the same mechanism as on an existing map,
 * built against a blank draft. Nothing exists on disk until the human accepts.
 */
export function StartScreen({ markerHint }: { markerHint: boolean }) {
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<ProposalPreview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const blank = useMemo(() => blankProduct(name), [name]);
  const guide = useMemo(() => deriveStartGuide(), []);
  // Shown under the text field while there is no usable name yet; nothing can be asked for against it.
  const placeholder = useMemo(() => {
    const draft = blankProduct("New product");
    if (!draft.ok) throw new Error("the blank draft could not be built");
    return draft.product;
  }, []);
  const extra = useMemo(() => ({ name }), [name]);
  // The accepted map is on disk now: load the editor on it.
  const onAccepted = useCallback(() => window.location.assign("/"), []);

  return (
    <main className="page" data-testid="start-screen">
      <header className="topbar">
        <div>
          <h1>Start a product map</h1>
          <p className="muted">There is no product here yet. Nothing is saved until you accept a proposal.</p>
        </div>
      </header>

      <GuidePanel
        guide={guide}
        proposalOpen={reviewing}
        onAction={(action) => document.getElementById(action.kind === "focus_proposal" ? "proposal-review" : name.trim() === "" ? "product-name" : "workshop-input")?.focus()}
      />

      <section className="panel" aria-label="Product name">
        <label className="field">
          <span>What is the product called?</span>
          <input
            id="product-name"
            data-testid="product-name-input"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            placeholder="Working name"
            disabled={reviewing}
            onChange={(event) => setName(event.target.value)}
          />
          <span className="muted">A working name is enough; the ids on the map are made from it.</span>
        </label>
      </section>

      {/* Always there, so text already written is not lost while the name is changed. */}
      <WorkshopPanel
        product={blank.ok ? blank.product : placeholder}
        // The name is the map's identity, so it has to exist before a proposal is built against it.
        // Not a disabled button: the reason is said, and the focus goes to the field.
        gate={() => {
          if (blank.ok) return null;
          document.getElementById("product-name")?.focus();
          return "Give it a working name first — one or two words are enough; the ids on the map are made from it. Your text stays as it is.";
        }}
        onPreview={setPreview}
        onReviewing={setReviewing}
        onAccepted={onAccepted}
        endpoints={{ propose: "/api/bootstrap", accept: "/api/bootstrap/accept" }}
        extra={extra}
        labels={{
          heading: "What do you want to build or improve?",
          intro:
            "Paste anything you already have: meeting notes, a transcript, a product description, requirements or rough thoughts. The text is treated as material to analyse, never as instructions; nothing is saved until you accept a proposal.",
          placeholder: "Meeting notes, a transcript, a product description, requirements, rough thoughts…",
          button: "Turn this into a map",
          busy: "Reading…",
          acceptNote: "Accepting creates the product as proposed revision 1. It does not approve it.",
        }}
        hint={
          markerHint ? (
            <details className="muted marker-hint" data-testid="marker-hint">
              <summary>No language model is connected: the text is read line by line, in this format</summary>
              <pre>
                {[
                  "Goal: Residents collect a parcel without waiting for a courier.",
                  "Persona: Resident — Lives in the building. [roles: customer, user]",
                  "Actor: Building manager — Owns the lobby. [roles: stakeholder]",
                  "Need (Resident): Get my parcel on the day it arrives.",
                  "Step: Resident opens the compartment — With a code. [personas: Resident] [needs: Get my parcel on the day it arrives]",
                ].join("\n")}
              </pre>
              <p>
                Persona: someone whose needs and steps you describe. Actor: someone involved whose needs you do not describe. A line
                that ends in a question mark is kept as an open question. Every other line is ignored. With a model configured
                (<code>ASM_AGENT_PROVIDER</code>), any text works.
              </p>
            </details>
          ) : null
        }
      />

      {preview && (
        <section className="panel" aria-label="Map preview" data-testid="map-preview">
          <h2>
            This is the map you would get <span className="muted">a preview; nothing is saved yet</span>
          </h2>
          <h3>What it is for</h3>
          <p className="goal-statement" data-testid="preview-goal">
            {preview.product.goal.statement}
          </p>
          <h3>Who is involved</h3>
          {preview.product.personas.length === 0 && <p className="muted">Nobody yet. The text names no one.</p>}
          <ul data-testid="preview-people">
            {preview.product.personas.map((actor) => (
              <li key={actor.id} data-persona={isPersona(actor)}>
                <strong>{actor.name}</strong>{" "}
                <span className="muted">
                  {rolesOf(actor).length > 0 ? rolesOf(actor).map((role) => ROLE_LABEL[role]).join(", ") : "role not stated"} ·{" "}
                  {isPersona(actor) ? "persona" : "involved, not a persona"}
                </span>
                <ul className="needs">
                  {preview.product.needs
                    .filter((need) => need.personaId === actor.id)
                    .map((need) => (
                      <li key={need.id}>{need.statement}</li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
          <h3>The path, from start to end</h3>
          {preview.product.narrative.length === 0 && <p className="muted">No steps yet. The text describes no path.</p>}
          <ol data-testid="preview-path">
            {[...preview.product.narrative]
              .sort((a, b) => a.sequence - b.sequence)
              .map((step) => (
                <li key={step.id}>
                  <strong>{step.title}</strong>
                  {step.description && <span className="muted"> — {step.description}</span>}
                </li>
              ))}
          </ol>
        </section>
      )}
    </main>
  );
}
