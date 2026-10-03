import { ValueChainRoleSchema, type Persona, type ValueChainRole } from "./schema";

/**
 * Who is on the map, and in what capacity.
 *
 * Every entry in `personas` is an actor: someone or something involved with
 * the product. Two things are said about an actor, and they are independent:
 *
 *   roles    how the actor relates to the value chain (buys, uses, benefits,
 *            operates, sells, governs, builds, or is a system). Several at once
 *            are possible. No role stated means exactly that: not stated.
 *   persona  whether the actor's needs and behaviour are modelled in the
 *            narrative. A role never decides this. Building the product does
 *            not make someone a persona, and neither does attending a workshop.
 *            An actor who is not a persona owns no need and takes part in no
 *            step; validation refuses a map that says otherwise. Such an actor
 *            can still be named, described, given roles, and be the one a
 *            worst case escalates to.
 *
 * An entry that says nothing about `persona` is a persona: that is what every
 * entry meant before the field existed, and old maps keep their meaning.
 */

export const VALUE_CHAIN_ROLES = ValueChainRoleSchema.options;

/** How a role is shown to a human. */
export const ROLE_LABEL: Record<ValueChainRole, string> = {
  customer: "Customer / buyer",
  user: "User",
  beneficiary: "Beneficiary",
  operator: "Operator / support",
  seller: "Seller / channel",
  stakeholder: "Stakeholder / governance",
  delivery_participant: "Delivery participant",
  system: "System / agent",
};

export function isPersona(actor: Pick<Persona, "persona">): boolean {
  return actor.persona !== false;
}

export function rolesOf(actor: Pick<Persona, "roles">): readonly ValueChainRole[] {
  return actor.roles ?? [];
}
