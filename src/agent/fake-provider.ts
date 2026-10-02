import { VALUE_CHAIN_ROLES, isPersona } from "../domain/actors";
import type { AgentOutput } from "../domain/map-patch";
import type { ProductDocument } from "../domain/schema";
import { reviewWithRules } from "./fake-review";
import type { AgentProvider, ReviewInput, ReviewProvider, StructureInput } from "./provider";

/**
 * Deterministic provider without any model. It only understands explicit
 * markers, one per line, optionally after a speaker name:
 *
 *   Goal: <statement>
 *   Persona: <name> — <description> [roles: customer, user]
 *   Actor: <name> — <description> [roles: stakeholder]
 *   Need (<persona name>): <statement>
 *   Step: <title> — <description> [personas: A, B] [needs: <need statement>; <another>] [after: <step title>]
 *   Assign: <persona name> -> <step title>
 *   Move: <step title> -> after <step title> | start | end
 *   Question: <question>
 *
 * `Persona` is someone whose needs and behaviour the narrative models; `Actor`
 * is someone involved whose needs are not modelled. Which of the two is said by
 * the marker alone, never by a role. Roles are the eight value-chain roles or
 * one of their everyday names (buyer, support, channel, governance, delivery,
 * agent). A need is referenced by its statement or the beginning of it.
 *
 * A line that ends in a question mark becomes an unresolved question. A marker
 * that names something the map does not have, a role that does not exist, or a
 * need or step for someone who is not a persona, becomes an unresolved
 * question instead of a guess. Every other line is ignored.
 *
 * It is the default provider and the one all tests run against.
 */

const MARKER =
  /^(?:[^:]{1,40}:\s+)?(Goal|Persona|Actor|Need|Step|Assign|Move|Question)\s*(?:\(([^)]*)\))?\s*:\s*(.+)$/i;
const SPEAKER = /^[^:]{1,40}:\s+/;
const DASH = /\s+[—–-]\s+/;
const ATTRIBUTE = /\[\s*([a-z]+)\s*:\s*([^\]]*)\]/gi;

const key = (text: string) => text.trim().toLowerCase();

/** Everyday names for the value-chain roles, next to the role names themselves. */
const ROLE_ALIAS: Record<string, (typeof VALUE_CHAIN_ROLES)[number]> = {
  buyer: "customer",
  support: "operator",
  channel: "seller",
  governance: "stakeholder",
  delivery: "delivery_participant",
  "delivery participant": "delivery_participant",
  agent: "system",
};

function roleOf(name: string): (typeof VALUE_CHAIN_ROLES)[number] | null {
  const wanted = key(name).replace(/[\s_-]+/g, " ");
  return VALUE_CHAIN_ROLES.find((role) => role.replace(/_/g, " ") === wanted) ?? ROLE_ALIAS[wanted] ?? null;
}

/** A need statement as written when it is referenced: case, surrounding space and a final full stop do not matter. */
const needKey = (text: string) => key(text).replace(/\.$/, "");

function lookup<T extends { id: string }>(items: T[], label: (item: T) => string, name: string): string | null {
  const wanted = key(name);
  const hit = items.find((item) =>
    label(item)
      .split(" / ")
      .concat(label(item))
      .some((alias) => key(alias) === wanted),
  );
  return hit ? hit.id : null;
}

export function structureWithMarkers(transcript: string, product: ProductDocument): AgentOutput {
  const out: AgentOutput = {
    summary: "",
    goal: null,
    personas: [],
    needs: [],
    steps: [],
    assignments: [],
    moves: [],
    unresolvedQuestions: [],
  };
  let ignored = 0;

  const explicit = (line: string) => ({ snippet: line, rationale: "Stated explicitly in the discussion.", confidence: 1 });
  const question = (line: string, text: string, rationale: string, confidence: number) =>
    out.unresolvedQuestions.push({ question: text, relatesTo: [], source: { snippet: line, rationale, confidence } });

  const persona = (name: string): string | null =>
    lookup(product.personas, (p) => p.name, name) ??
    out.personas.find((p) => key(p.name) === key(name))?.ref ??
    null;
  /** Whether that id or ref is someone whose needs and behaviour are modelled. */
  const modelled = (idOrRef: string): boolean => {
    const existing = product.personas.find((p) => p.id === idOrRef);
    return existing ? isPersona(existing) : (out.personas.find((p) => p.ref === idOrRef)?.persona ?? false);
  };
  const need = (statement: string): string | null => {
    const wanted = needKey(statement);
    if (wanted === "") return null;
    const matches = <T,>(items: T[], text: (item: T) => string) =>
      items.find((item) => needKey(text(item)) === wanted) ?? items.find((item) => needKey(text(item)).startsWith(wanted));
    return matches(product.needs, (n) => n.statement)?.id ?? matches(out.needs, (n) => n.statement)?.ref ?? null;
  };
  /** Splits `[name: value]` attributes off a marker's text. */
  const attributesOf = (text: string) => {
    const attributes = new Map<string, string>();
    const body = text.replace(ATTRIBUTE, (_all, name: string, value: string) => {
      attributes.set(name.toLowerCase(), value.trim());
      return "";
    });
    return { attributes, body: body.trim() };
  };
  const step = (title: string): string | null =>
    lookup(product.narrative, (s) => s.title, title) ??
    out.steps.find((s) => key(s.title) === key(title))?.ref ??
    null;

  for (const rawLine of transcript.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;

    const match = MARKER.exec(line);
    if (!match) {
      const said = line.replace(SPEAKER, "");
      if (said.endsWith("?")) question(line, said, "Asked in the discussion and not answered there.", 0.5);
      else ignored++;
      continue;
    }

    const marker = match[1].toLowerCase();
    const argument = match[2]?.trim() ?? "";
    const rest = match[3].trim();

    if (marker === "goal") {
      out.goal = { statement: rest, source: explicit(line) };
    } else if (marker === "persona" || marker === "actor") {
      const { attributes, body } = attributesOf(rest);
      const [name, ...description] = body.split(DASH);
      const roles: string[] = [];
      for (const said of (attributes.get("roles") ?? attributes.get("role") ?? "").split(",").map((r) => r.trim()).filter(Boolean)) {
        const role = roleOf(said);
        if (role && !roles.includes(role)) roles.push(role);
        else if (!role) question(line, `Which role does "${name.trim()}" have? "${said}" is not one of the value-chain roles.`, "The line names a role that does not exist.", 0.5);
      }
      out.personas.push({
        ref: `new:persona-${out.personas.length + 1}`,
        name: name.trim(),
        description: description.join(" — ").trim(),
        roles,
        // Said by the marker, and by nothing else.
        persona: marker === "persona",
        source: explicit(line),
      });
    } else if (marker === "need") {
      const owner = persona(argument);
      if (!owner) {
        question(line, `Whose need is this? "${argument}" is not a persona on the map: ${rest}`, "The need names a persona that is not on the map.", 0.5);
        continue;
      }
      if (!modelled(owner)) {
        question(line, `Is "${argument}" a persona? They are on the map as involved but not modelled, and this names a need of theirs: ${rest}`, "The need belongs to someone who is not a persona.", 0.5);
        continue;
      }
      out.needs.push({ ref: `new:need-${out.needs.length + 1}`, persona: owner, statement: rest, source: explicit(line) });
    } else if (marker === "step") {
      const { attributes, body } = attributesOf(rest);
      const [title, ...description] = body.split(DASH);

      const personas: string[] = [];
      for (const name of (attributes.get("personas") ?? "").split(",").map((n) => n.trim()).filter(Boolean)) {
        const id = persona(name);
        if (id && modelled(id)) personas.push(id);
        else if (id) question(line, `Is "${name}" a persona? They are on the map as involved but not modelled, and the step "${title.trim()}" has them take part.`, "The step names someone who is not a persona.", 0.5);
        else question(line, `Who is "${name}"? The step "${title.trim()}" names a persona that is not on the map.`, "The step names a persona that is not on the map.", 0.5);
      }

      const needs: string[] = [];
      for (const statement of (attributes.get("needs") ?? attributes.get("need") ?? "").split(";").map((n) => n.trim()).filter(Boolean)) {
        const id = need(statement);
        if (id && !needs.includes(id)) needs.push(id);
        else if (!id) question(line, `Which need does the step "${title.trim()}" serve? "${statement}" is not a need on the map.`, "The step names a need that is not on the map.", 0.5);
      }

      let placement: AgentOutput["steps"][number]["placement"] = { kind: "end", step: null };
      const after = attributes.get("after");
      if (after) {
        const anchor = step(after);
        if (anchor) placement = { kind: "after", step: anchor };
        else question(line, `Where does the step "${title.trim()}" belong? "${after}" is not a step on the map.`, "The step is placed after a step that is not on the map.", 0.5);
      }

      out.steps.push({
        ref: `new:step-${out.steps.length + 1}`,
        title: title.trim(),
        description: description.join(" — ").trim(),
        personas,
        needs,
        placement,
        source: explicit(line),
      });
    } else if (marker === "assign") {
      const [who, where] = rest.split(/\s*->\s*/);
      const personaId = persona(who ?? "");
      const stepId = step(where ?? "");
      if (!personaId || !stepId) {
        question(line, `Which persona and step are meant by "${rest}"?`, "The assignment names a persona or step that is not on the map.", 0.5);
        continue;
      }
      const alreadyThere = product.narrative.find((s) => s.id === stepId)?.personaIds.includes(personaId);
      if (alreadyThere) ignored++;
      else out.assignments.push({ step: stepId, persona: personaId, source: explicit(line) });
    } else if (marker === "move") {
      const [what, target] = rest.split(/\s*->\s*/);
      const stepId = step(what ?? "");
      const where = (target ?? "").trim();
      const anchor = /^after\s+/i.test(where) ? step(where.replace(/^after\s+/i, "")) : null;
      const edge = /^(start|end)$/i.test(where) ? (where.toLowerCase() as "start" | "end") : null;
      if (!stepId || (!anchor && !edge)) {
        question(line, `Which steps are meant by "${rest}"?`, "The suggested order names a step that is not on the map.", 0.5);
        continue;
      }
      out.moves.push({
        step: stepId,
        placement: anchor ? { kind: "after", step: anchor } : { kind: edge!, step: null },
        source: explicit(line),
      });
    } else {
      question(line, rest, "Raised as an open question in the discussion.", 1);
    }
  }

  const count = out.personas.length + out.needs.length + out.steps.length + out.assignments.length + out.moves.length + (out.goal ? 1 : 0);
  out.summary =
    `${count} proposed change(s) and ${out.unresolvedQuestions.length} unresolved question(s) from explicit markers; ` +
    `${ignored} line(s) were not structured.`;
  return out;
}

export class FakeProvider implements AgentProvider, ReviewProvider {
  readonly name = "fake (deterministic marker parser, no model)";

  async structure({ transcript, product }: StructureInput): Promise<unknown> {
    return structureWithMarkers(transcript, product);
  }

  async review({ product }: ReviewInput): Promise<unknown> {
    return reviewWithRules(product);
  }
}
