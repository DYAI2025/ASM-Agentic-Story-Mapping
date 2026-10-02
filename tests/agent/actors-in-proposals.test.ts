import { describe, expect, it } from "vitest";
import { structureWithMarkers } from "../../src/agent/fake-provider";
import { SYSTEM_PROMPT } from "../../src/agent/prompt";
import { isPersona } from "../../src/domain/actors";
import { applyMapPatch, describePatch, resolveProposal, type AgentOutput } from "../../src/domain/map-patch";
import { validateProduct } from "../../src/domain/validate";
import { loadFixture, mutableFixture } from "../domain/helpers";

const source = (snippet: string) => ({ snippet, rationale: "", confidence: 1 });
const empty = (): AgentOutput => ({ summary: "", goal: null, personas: [], needs: [], steps: [], assignments: [], moves: [], unresolvedQuestions: [] });
const codes = (result: { ok: boolean; issues?: { code: string }[] }) => (result.issues ?? []).map((i) => i.code);

/** Structure with the deterministic provider and resolve against the same map. */
function propose(text: string, product = loadFixture()) {
  return resolveProposal(product, structureWithMarkers(text, product), text, "fake");
}

describe("the deterministic provider: who is a persona is said by the marker, never by a role", () => {
  it("Persona and Actor differ only in the persona answer; roles are carried as stated", () => {
    const out = structureWithMarkers(
      ["Persona: Auditor — Checks the books. [roles: governance, user]", "Actor: Installer — Mounts the device. [roles: delivery]"].join("\n"),
      loadFixture(),
    );
    expect(out.personas.map((p) => [p.name, p.roles, p.persona])).toEqual([
      ["Auditor", ["stakeholder", "user"], true],
      ["Installer", ["delivery_participant"], false],
    ]);
  });

  it("every role, by its own name or its everyday name, with any role on either marker", () => {
    const names = ["customer", "buyer", "user", "beneficiary", "operator", "support", "seller", "channel", "stakeholder", "governance", "delivery_participant", "delivery participant", "delivery", "system", "agent"];
    for (const name of names) {
      const asPersona = structureWithMarkers(`Persona: Someone — x [roles: ${name}]`, loadFixture());
      const asActor = structureWithMarkers(`Actor: Someone — x [roles: ${name}]`, loadFixture());
      expect(asPersona.personas[0].roles, name).toHaveLength(1);
      expect(asPersona.personas[0].persona, name).toBe(true);
      expect(asActor.personas[0].persona, name).toBe(false);
      expect(asActor.personas[0].roles, name).toEqual(asPersona.personas[0].roles);
    }
  });

  it("a role that does not exist becomes a question, not a guess", () => {
    const out = structureWithMarkers("Persona: Auditor — Checks. [roles: wizard, user]", loadFixture());
    expect(out.personas[0].roles).toEqual(["user"]);
    expect(out.unresolvedQuestions).toHaveLength(1);
    expect(out.unresolvedQuestions[0].question).toContain('"wizard" is not one of the value-chain roles');
  });

  it("a need or a step for someone who is not a persona becomes a question, and the proposal stays acceptable", () => {
    const text = [
      "Actor: Installer — Mounts the device. [roles: delivery]",
      "Need (Installer): Know the wall type in advance.",
      "Step: Mount the device — On site. [personas: Installer, Developer]",
    ].join("\n");
    const result = propose(text);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const ops = result.patch.operations;
    expect(ops.filter((o) => o.op === "add_need")).toEqual([]);
    expect(ops.find((o) => o.op === "add_step")).toMatchObject({ personaIds: ["persona-developer"] });
    expect(ops.filter((o) => o.op === "add_question").map((o) => o.op === "add_question" && o.question)).toEqual([
      expect.stringContaining('Is "Installer" a persona?'),
      expect.stringContaining('Is "Installer" a persona?'),
    ]);
    const applied = applyMapPatch(loadFixture(), result.patch);
    expect(applied.ok && validateProduct(applied.product).ok).toBe(true);
  });

  it("the same holds for someone already on the map as not a persona", () => {
    const product = mutableFixture();
    product.personas.push({ id: "persona-installer", name: "Installer", description: "", roles: ["delivery_participant"], persona: false });
    const out = structureWithMarkers("Need (Installer): Know the wall type.\nStep: Mount — x [personas: Installer]", product);
    expect(out.needs).toEqual([]);
    expect(out.steps[0].personas).toEqual([]);
    expect(out.unresolvedQuestions).toHaveLength(2);
  });

  it("a step references needs by their statement or its beginning; an unknown one becomes a question", () => {
    const text = [
      "Need (Developer): Know which slice to build first.",
      "Step: Pick the slice — Together. [personas: Developer] [needs: Know which slice to build first; receive a first slice that is small; A need nobody stated]",
    ].join("\n");
    const out = structureWithMarkers(text, loadFixture());
    expect(out.steps[0].needs).toEqual(["new:need-1", "need-buildable-slice"]);
    expect(out.unresolvedQuestions.map((q) => q.question)).toEqual([expect.stringContaining('"A need nobody stated" is not a need on the map')]);
  });

  it("the Persona marker of earlier maps still means what it meant", () => {
    const out = structureWithMarkers("Persona: Support Lead — Hears first.", loadFixture());
    expect(out.personas[0]).toMatchObject({ name: "Support Lead", description: "Hears first.", roles: [], persona: true });
  });
});

describe("the proposal contract for people", () => {
  const withPerson = (extra: Partial<AgentOutput["personas"][number]>) => {
    const output = empty();
    output.personas.push({ ref: "new:a", name: "Auditor", description: "", roles: [], persona: true, source: source("Auditor"), ...extra });
    return resolveProposal(loadFixture(), output, "Auditor", "stub");
  };

  it("refuses a role that does not exist and a role named twice", () => {
    expect(codes(withPerson({ roles: ["wizard"] }))).toEqual(["unknown_role"]);
    expect(codes(withPerson({ roles: ["user", "user"] }))).toEqual(["duplicate_role"]);
  });

  it("refuses output that does not say whether someone is a persona", () => {
    const output = empty() as unknown as { personas: unknown[] };
    output.personas.push({ ref: "new:a", name: "Auditor", description: "", roles: ["delivery_participant"], source: source("Auditor") });
    expect(codes(resolveProposal(loadFixture(), output, "Auditor", "stub")).every((c) => c.startsWith("agent_output_"))).toBe(true);
  });

  it("a delivery participant arrives as a persona only if the output says so", () => {
    for (const persona of [true, false]) {
      const result = withPerson({ roles: ["delivery_participant"], persona });
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      const applied = applyMapPatch(loadFixture(), result.patch);
      if (!applied.ok) throw new Error(JSON.stringify(applied.issues));
      const added = applied.product.personas.at(-1)!;
      expect(isPersona(added)).toBe(persona);
      expect(added.roles).toEqual(["delivery_participant"]);
      // The human sees the answer before accepting.
      expect(describePatch(loadFixture(), result.patch)[0].headline).toBe(
        persona ? "Add persona “Auditor”" : "Add “Auditor”: involved, not a persona (their needs are not modelled)",
      );
    }
  });

  it("a proposal that gives a non-persona a step is refused as a whole, not half applied", () => {
    const output = empty();
    output.personas.push({ ref: "new:a", name: "Auditor", description: "", roles: [], persona: false, source: source("Auditor") });
    output.steps.push({ ref: "new:s", title: "Audit", description: "", personas: ["new:a"], needs: [], placement: { kind: "end", step: null }, source: source("Auditor") });
    expect(codes(resolveProposal(loadFixture(), output, "Auditor", "stub"))).toEqual(["step_of_non_persona"]);
  });

  it("the instructions to a model say that a role never decides who is a persona", () => {
    expect(SYSTEM_PROMPT).toContain("A role never decides this");
    expect(SYSTEM_PROMPT).toContain("Do not make up a need so that a step has one");
    for (const role of ["customer", "user", "beneficiary", "operator", "seller", "stakeholder", "delivery_participant", "system"])
      expect(SYSTEM_PROMPT).toContain(role);
  });
});
