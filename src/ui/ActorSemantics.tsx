"use client";

import { useEffect, useRef, useState } from "react";
import { ROLE_LABEL, VALUE_CHAIN_ROLES, isPersona, rolesOf } from "../domain/actors";
import type { Persona, ValueChainRole } from "../domain/schema";

/**
 * What the map says about one actor: the roles in the value chain, and whether
 * the actor is a persona. Both are shown as stated. Nothing is inferred: no
 * role stated is shown as "not stated", and a role never switches the persona
 * answer.
 *
 * Changing either is a change of meaning and goes through the same save path
 * as any other edit.
 */
export function ActorSemantics({
  actor,
  needCount,
  readOnly,
  onSave,
}: {
  actor: Persona;
  /** How many needs on the map belong to this actor. */
  needCount: number;
  readOnly: boolean;
  onSave: (roles: ValueChainRole[], persona: boolean) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [roles, setRoles] = useState<ValueChainRole[]>([...rolesOf(actor)]);
  const [persona, setPersona] = useState(isPersona(actor));
  const stated = rolesOf(actor);
  const asPersona = isPersona(actor);
  // An open form describes the actor as it was when the form opened. If the map says something else
  // now (an import, an accepted proposal, a save), or editing is no longer allowed, the form is closed
  // rather than left to write its old state over the new one.
  const signature = `${stated.join(",")}|${asPersona}|${readOnly}`;
  useEffect(() => setEditing(false), [signature]);
  // When the form closes, keyboard focus goes back to the button that opened it.
  const opener = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) opener.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  return (
    <div className="actor" data-testid={`actor-${actor.id}`} data-persona={asPersona} data-unresolved={asPersona && needCount === 0}>
      <p className="chips" data-testid={`roles-${actor.id}`}>
        {stated.length > 0 ? (
          stated.map((role) => (
            <span key={role} className="chip" data-role={role}>
              {ROLE_LABEL[role]}
            </span>
          ))
        ) : (
          <span className="muted">Role not stated</span>
        )}
      </p>
      <p data-testid={`perspective-${actor.id}`}>
        {asPersona ? (
          <span className="badge approved">Persona</span>
        ) : (
          <>
            <span className="badge neutral">Not a persona</span>{" "}
            <span className="muted">Involved, but their needs and behaviour are not modelled here: no need, no step.</span>
          </>
        )}
      </p>
      {asPersona && needCount === 0 && (
        <p className="flagged" data-testid={`unresolved-${actor.id}`}>
          ⚑ Unresolved: no need of this persona is on the map. Say what they need, or that they are not a persona. ASM does not
          fill this in.
        </p>
      )}

      {!readOnly && !editing && (
        <button
          ref={opener}
          type="button"
          className="link"
          aria-label={`Roles and persona… ${actor.name}`}
          onClick={() => {
            setRoles([...stated]);
            setPersona(asPersona);
            setEditing(true);
          }}
        >
          Roles and persona…
        </button>
      )}

      {!readOnly && editing && (
        <form
          className="actor-form"
          data-testid={`actor-form-${actor.id}`}
          onSubmit={async (event) => {
            event.preventDefault();
            const next = VALUE_CHAIN_ROLES.filter((role) => roles.includes(role));
            // Nothing changed: nothing is saved, so an approved revision is not reopened by looking.
            const unchanged = persona === asPersona && next.length === stated.length && next.every((role) => stated.includes(role));
            if (unchanged || (await onSave(next, persona))) setEditing(false);
          }}
        >
          <fieldset>
            <legend>Role in the value chain (any that apply)</legend>
            {VALUE_CHAIN_ROLES.map((role, index) => (
              <label key={role} className="row">
                <input
                  type="checkbox"
                  autoFocus={index === 0}
                  checked={roles.includes(role)}
                  onChange={() => setRoles(roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role])}
                />
                <span>{ROLE_LABEL[role]}</span>
              </label>
            ))}
          </fieldset>
          <label className="row">
            <input type="checkbox" checked={persona} onChange={() => setPersona(!persona)} />
            <span>Persona: their needs and behaviour are modelled in this narrative</span>
          </label>
          <p className="muted">A role does not decide this. Someone who builds or sells the product is a persona only if you say so.</p>
          <div className="row">
            <button type="submit">Save roles</button>
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
