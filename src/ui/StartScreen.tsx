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
            placeholder="A working name is enough"
            disabled={reviewing}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      </section>

      {blank.ok ? (
        <WorkshopPanel
          product={blank.product}
          onPreview={setPreview}
          onReviewing={setReviewing}
          onAccepted={onAccepted}
          endpoints={{ propose: "/api/bootstrap", accept: "/api/bootstrap/accept" }}
          extra={extra}
          labels={{
            heading: "What do you want to build or improve?",
            intro:
              "Write it down the way you would tell a colleague: what it is for, who is involved, what they need, and how it goes when everything works. Notes or a conversation are fine. The text is treated as material to analyse, never as instructions.",
            placeholder: "What it is for, who is involved, what they need, the steps from start to end…",
            button: "Turn this into a map",
            busy: "Reading…",
            acceptNote: "Accepting creates the product as proposed revision 1. It does not approve it.",
          }}
          hint={
            markerHint ? (
              <details className="muted" data-testid="marker-hint">
                <summary>No language model is connected: write one item per line, like this</summary>
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
                  Persona: someone whose needs and steps you describe. Actor: someone involved whose needs you do not describe. Lines
                  without such a start are kept as questions if they end in a question mark, and ignored otherwise.
                </p>
              </details>
            ) : null
          }
        />
      ) : (
        <section className="panel" data-testid="name-needed">
          <p className="muted">Give the product a name first.</p>
        </section>
      )}

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
