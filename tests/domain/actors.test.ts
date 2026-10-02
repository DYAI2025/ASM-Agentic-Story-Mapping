import { describe, expect, it } from "vitest";
import { VALUE_CHAIN_ROLES, isPersona, rolesOf } from "../../src/domain/actors";
import { fingerprint } from "../../src/domain/fingerprint";
import { deriveGuide } from "../../src/domain/guide";
import { DomainError, approveRevision, setActorRoles, setPersonaPerspective } from "../../src/domain/operations";
import { reviewNarrative } from "../../src/domain/review";
import type { ProductDocument } from "../../src/domain/schema";
import { exportProductJson, exportProductYaml, parseProductText } from "../../src/domain/serialize";
import { SLICE_DERIVATION_VERSION, candidateFingerprint, proposeSlices } from "../../src/domain/slices";
import { validateProduct } from "../../src/domain/validate";
import { fixtureText, loadFixture, mutableFixture } from "./helpers";

/** Fingerprint of product/asm.product.yaml at 686bdc5, before roles and the persona flag existed. */
const FIXTURE_FINGERPRINT_BEFORE = "1cb56c61";

const codes = (p: ProductDocument) => {
  const result = validateProduct(p);
  return result.ok ? [] : result.issues.map((i) => i.code);
};
const findings = (p: ProductDocument, code: string) => reviewNarrative(p).filter((f) => f.code === code);

/** The fixture plus one more entry in the people list, on no step and with no need. */
function withActor(extra: { roles?: string[]; persona?: boolean }, id = "persona-build-engineer"): ProductDocument {
  const p = mutableFixture();
  p.personas.push({ id, name: "Build engineer", description: "Builds the slice.", ...extra } as ProductDocument["personas"][number]);
  return p;
}

describe("roles: how someone relates to the value chain", () => {
  it("knows exactly the eight roles of the prototype contract", () => {
    expect([...VALUE_CHAIN_ROLES]).toEqual([
      "customer",
      "user",
      "beneficiary",
      "operator",
      "seller",
      "stakeholder",
      "delivery_participant",
      "system",
    ]);
  });

  it("one actor can carry several roles", () => {
    const p = withActor({ roles: ["customer", "user", "beneficiary"] });
    expect(codes(p)).toEqual([]);
    expect(rolesOf(p.personas.at(-1)!)).toEqual(["customer", "user", "beneficiary"]);
  });

  it("refuses a role that is not one of the eight, an empty role list and a role named twice", () => {
    expect(codes(withActor({ roles: ["developer"] }))).toEqual(["schema_invalid_value"]);
    expect(codes(withActor({ roles: [] }))).toEqual(["schema_too_small"]);
    expect(codes(withActor({ roles: ["user", "user"] }))).toEqual(["duplicate_role"]);
  });

  it("refuses a persona flag that is not true or false", () => {
    const p = withActor({});
    (p.personas.at(-1) as unknown as { persona: string }).persona = "yes";
    expect(codes(p)).toEqual(["schema_invalid_type"]);
  });

  it("setActorRoles sets, replaces and clears the roles, and reopens an approved revision", () => {
    const approved = approveRevision(loadFixture(), { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" });
    const set = setActorRoles(approved, "persona-developer", ["delivery_participant", "user"]);
    expect(rolesOf(set.personas.find((e) => e.id === "persona-developer")!)).toEqual(["delivery_participant", "user"]);
    expect(set.revision).toEqual({ number: 2, status: "proposed" });

    const cleared = setActorRoles(set, "persona-developer", []);
    expect("roles" in cleared.personas.find((e) => e.id === "persona-developer")!).toBe(false);
    expect(() => setActorRoles(approved, "persona-developer", ["developer" as never])).toThrow(DomainError);
    expect(() => setActorRoles(approved, "persona-nobody", ["user"])).toThrow(DomainError);
  });
});

describe("persona: a perspective, separate from the role", () => {
  it("a delivery participant is not a persona unless the map says so", () => {
    const actor = withActor({ roles: ["delivery_participant"], persona: false });
    expect(codes(actor)).toEqual([]);
    expect(isPersona(actor.personas.at(-1)!)).toBe(false);
    // Not a persona: no need is missing, and nobody is told the actor takes part in no step.
    expect(findings(actor, "persona_without_need")).toEqual([]);
    expect(findings(actor, "orphan_persona")).toEqual([]);
  });

  it("no role makes someone a persona or stops them being one: only the flag does", () => {
    for (const role of VALUE_CHAIN_ROLES) {
      const off = withActor({ roles: [role], persona: false });
      const on = withActor({ roles: [role], persona: true });
      expect(isPersona(off.personas.at(-1)!), role).toBe(false);
      expect(isPersona(on.personas.at(-1)!), role).toBe(true);
      expect(findings(off, "persona_without_need"), role).toHaveLength(0);
      expect(findings(on, "persona_without_need"), role).toHaveLength(1);
    }
  });

  it("the same developer can be a persona in one product and only a delivery participant in another", () => {
    const inAsm = setActorRoles(loadFixture(), "persona-developer", ["delivery_participant", "user"]);
    expect(isPersona(inAsm.personas.find((e) => e.id === "persona-developer")!)).toBe(true);

    const elsewhere = mutableFixture();
    // Another product; the id is kept because decisions on the fixture refer to it.
    elsewhere.product = { ...elsewhere.product, name: "Customer shop", summary: "Another product." };
    const developer = elsewhere.personas.find((e) => e.id === "persona-developer")!;
    const theirNeeds = new Set(elsewhere.needs.filter((n) => n.personaId === developer.id).map((n) => n.id));
    elsewhere.needs = elsewhere.needs.filter((n) => !theirNeeds.has(n.id));
    // There the developer has no need on the map and takes part in no step.
    elsewhere.narrative.forEach((s) => {
      s.needIds = s.needIds.filter((id) => !theirNeeds.has(id));
      s.personaIds = s.personaIds.filter((id) => id !== developer.id);
    });
    elsewhere.decisions = elsewhere.decisions
      .map((d) => ({ ...d, relatesTo: d.relatesTo.filter((id) => !theirNeeds.has(id)) }))
      .filter((d) => d.relatesTo.length > 0);
    Object.assign(developer, { roles: ["delivery_participant"], persona: false });
    expect(codes(elsewhere)).toEqual([]);
    expect(isPersona(developer)).toBe(false);
    expect(findings(elsewhere, "persona_without_need")).toEqual([]);
  });

  it("an actor who is not a persona cannot own a need: the map would contradict itself", () => {
    const p = mutableFixture();
    Object.assign(p.personas.find((e) => e.id === "persona-developer")!, { persona: false });
    expect(codes(p)).toContain("need_of_non_persona");
    expect(() => setPersonaPerspective(loadFixture(), "persona-developer", false)).toThrow(/owns a need/);
  });

  it("setPersonaPerspective records the human's answer explicitly, both ways, and reopens an approved revision", () => {
    const approved = approveRevision(withActor({ roles: ["delivery_participant"] }), { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" });
    const off = setPersonaPerspective(approved, "persona-build-engineer", false);
    expect(off.personas.at(-1)!.persona).toBe(false);
    expect(off.revision).toEqual({ number: 2, status: "proposed" });
    const on = setPersonaPerspective(off, "persona-build-engineer", true);
    expect(on.personas.at(-1)!.persona).toBe(true);
  });
});

describe("a persona without a need is unresolved, and stays unresolved", () => {
  it("is reported as a gap that names the persona", () => {
    const p = withActor({ roles: ["user"], persona: true });
    const [finding] = findings(p, "persona_without_need");
    expect(finding).toMatchObject({ id: "persona_without_need:persona-build-engineer", level: "gap", relatesTo: ["persona-build-engineer"] });
    expect(finding.message).toContain("Build engineer");
    expect(finding.message).toContain("unresolved");
  });

  it("nothing invents the need: every operation that touches the actor returns the needs it was given", () => {
    const p = withActor({ roles: ["delivery_participant"], persona: false });
    const before = JSON.stringify(p.needs);
    const outputs = [
      setPersonaPerspective(p, "persona-build-engineer", true),
      setActorRoles(p, "persona-build-engineer", ["user", "customer"]),
      setActorRoles(setPersonaPerspective(p, "persona-build-engineer", true), "persona-build-engineer", []),
      approveRevision(setPersonaPerspective(p, "persona-build-engineer", true), { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" }),
    ];
    for (const out of outputs) {
      expect(JSON.stringify(out.needs)).toBe(before);
      const reread = parseProductText(exportProductYaml(out));
      expect(reread.ok && JSON.stringify(reread.product.needs)).toBe(before);
    }
    reviewNarrative(p);
    deriveGuide(p, null);
    expect(JSON.stringify(p.needs)).toBe(before);
  });

  it("the guide's people step is not reached while a persona has no need", () => {
    expect(deriveGuide(loadFixture(), null).currentStepId).toBe("approve");
    expect(deriveGuide(withActor({ roles: ["user"], persona: true }), null).currentStepId).toBe("people");
    // The same actor, not a persona: nothing is unresolved.
    expect(deriveGuide(withActor({ roles: ["delivery_participant"], persona: false }), null).currentStepId).toBe("approve");
  });

  it("a map whose only people are not personas has nobody to build for", () => {
    const p = mutableFixture();
    const gone = new Set(p.needs.map((n) => n.id));
    p.needs = [];
    p.narrative.forEach((s) => ((s.needIds = []), (s.personaIds = [])));
    p.decisions = p.decisions.map((d) => ({ ...d, relatesTo: d.relatesTo.filter((id) => !gone.has(id)) })).filter((d) => d.relatesTo.length > 0);
    p.personas.forEach((e) => Object.assign(e, { persona: false }));
    expect(codes(p)).toEqual([]);
    expect(deriveGuide(p, null).currentStepId).toBe("people");
  });
});

describe("whoever has a need or a step on the map is a persona", () => {
  it("an actor who is not a persona cannot take part in a step", () => {
    const p = withActor({ roles: ["delivery_participant"], persona: false });
    p.narrative[0].personaIds.push("persona-build-engineer");
    expect(codes(p)).toEqual(["step_of_non_persona"]);
    // The same actor as a persona may: the flag is what decides.
    Object.assign(p.personas.at(-1)!, { persona: true });
    expect(codes(p)).toEqual([]);
  });

  it("so a persona on steps cannot be switched off, and the reason names the step", () => {
    expect(() => setPersonaPerspective(loadFixture(), "persona-domain-ux", false)).toThrow(/takes part in step/);
  });

  it("an actor who is not a persona can still be the one a worst case escalates to", () => {
    const p = withActor({ roles: ["operator"], persona: false });
    p.wcbc.find((b) => b.kind === "worst_case")!.outcome = { kind: "escalation", toPersonaId: "persona-build-engineer" };
    expect(codes(p)).toEqual([]);
  });

  it("slice candidates and their fingerprints are what they were: the derivation rules did not change", () => {
    expect(SLICE_DERIVATION_VERSION).toBe(1);
    const before = proposeSlices(loadFixture());
    const after = proposeSlices(withActor({ roles: ["delivery_participant"], persona: false }));
    if (!before.ok || !after.ok) throw new Error("no candidates");
    // Someone who is not a persona being on the map changes no candidate.
    expect(after.candidates.map(candidateFingerprint)).toEqual(before.candidates.map(candidateFingerprint));
  });
});

describe("existing maps mean what they meant", () => {
  it("the fixture's fingerprint is the one it had before roles and the persona flag existed", () => {
    expect(fingerprint(loadFixture())).toBe(FIXTURE_FINGERPRINT_BEFORE);
  });

  it("an entry without the new fields is a persona with no role stated, and nothing adds the fields on its own", () => {
    const p = loadFixture();
    for (const entry of p.personas) {
      expect(isPersona(entry)).toBe(true);
      expect(rolesOf(entry)).toEqual([]);
      expect("roles" in entry || "persona" in entry).toBe(false);
    }
    for (const text of [exportProductYaml(p), exportProductJson(p)]) {
      expect(text).not.toMatch(/roles|persona:|"persona"/);
      const again = parseProductText(text);
      expect(again.ok && fingerprint(again.product)).toBe(FIXTURE_FINGERPRINT_BEFORE);
    }
    expect(fixtureText()).not.toMatch(/^\s+roles:|^\s+persona:/m);
  });

  it("roles and the persona flag survive a YAML and a JSON round trip, in a fixed position", () => {
    const p = setPersonaPerspective(withActor({ roles: ["seller", "stakeholder"] }), "persona-build-engineer", false);
    for (const text of [exportProductYaml(p), exportProductJson(p)]) {
      const again = parseProductText(text);
      if (!again.ok) throw new Error(JSON.stringify(again.issues));
      expect(again.product.personas.at(-1)).toEqual({
        id: "persona-build-engineer",
        name: "Build engineer",
        description: "Builds the slice.",
        roles: ["seller", "stakeholder"],
        persona: false,
      });
      expect(fingerprint(again.product)).toBe(fingerprint(p));
    }
    expect(exportProductYaml(p)).toBe(exportProductYaml(parseProductTextOrThrow(exportProductJson(p))));
  });

  it("the order roles are written in carries no meaning: same fingerprint, and one exported order", () => {
    const a = withActor({ roles: ["delivery_participant", "user"] });
    const b = withActor({ roles: ["user", "delivery_participant"] });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(exportProductYaml(a)).toBe(exportProductYaml(b));
    expect(parseProductTextOrThrow(exportProductYaml(a)).personas.at(-1)!.roles).toEqual(["user", "delivery_participant"]);
  });

  it("a role or the persona flag is part of the map's meaning: changing either changes the fingerprint", () => {
    const base = withActor({ roles: ["user"], persona: false });
    const otherRole = withActor({ roles: ["customer"], persona: false });
    const otherFlag = withActor({ roles: ["user"], persona: true });
    expect(new Set([fingerprint(base), fingerprint(otherRole), fingerprint(otherFlag)]).size).toBe(3);
  });
});

function parseProductTextOrThrow(text: string): ProductDocument {
  const result = parseProductText(text);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.product;
}
