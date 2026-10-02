import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExecutionBrief } from "../../src/domain/brief";
import { fingerprint } from "../../src/domain/fingerprint";
import { deriveGuide } from "../../src/domain/guide";
import { AgentOutputSchema, MapPatchSchema } from "../../src/domain/map-patch";
import { approveRevision, setCardRow, updateCard } from "../../src/domain/operations";
import { AgentReviewOutputSchema } from "../../src/domain/review";
import { ProductDocumentSchema, type ProductDocument } from "../../src/domain/schema";
import {
  WORK_STATE_VERSION,
  confirmPersonaCheck,
  resolvePersonaCheck,
  resolveSelection,
  selectSlice,
  validateWorkState,
  type PersonaCheck,
} from "../../src/domain/work-state";
import { loadWorkState, saveWorkState } from "../../src/server/store";
import { fixtureText, loadFixture } from "./helpers";

const APPROVAL = { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" };
const approved = (p: ProductDocument = loadFixture()) => approveRevision(p, APPROVAL);
const confirm = (p: ProductDocument, confirmedBy = "Maya") =>
  confirmPersonaCheck(p, { confirmedBy, confirmedAt: "2026-10-02T08:00:00.000Z", mapFingerprint: fingerprint(p) });
const choice = (p: ProductDocument, personaCheck: PersonaCheck | null) => ({
  candidateId: "slice-outcome-thread",
  selectedBy: "Maya",
  selectedAt: "2026-10-02T09:00:00.000Z",
  mapFingerprint: fingerprint(p),
  personaCheck,
});
const codes = (result: { ok: boolean; issues?: { code: string }[] }) => (result.issues ?? []).map((i) => i.code);

describe("the people check: a named human says they considered who else is relevant", () => {
  it("is recorded as given, bound to the product, the revision and the map as it was", () => {
    const p = approved();
    expect(confirm(p)).toEqual({
      productId: "asm",
      revision: 1,
      mapFingerprint: fingerprint(p),
      confirmedBy: "Maya",
      confirmedAt: "2026-10-02T08:00:00.000Z",
    });
    expect(resolvePersonaCheck(p, confirm(p))).toEqual({ ok: true });
  });

  it("needs a name, an approved narrative, and the map the human was looking at", () => {
    const p = approved();
    expect(() => confirm(p, "  ")).toThrow(/name of the human/);
    expect(() => confirm(loadFixture())).toThrow(/not approved/);
    expect(() => confirmPersonaCheck(p, { confirmedBy: "Maya", confirmedAt: "2026-10-02T08:00:00.000Z", mapFingerprint: "00000000" })).toThrow(/map has changed/);
  });

  it("is work state: confirming reads the product and changes nothing in it", () => {
    const p = approved();
    const before = JSON.stringify(p);
    confirm(p);
    expect(JSON.stringify(p)).toBe(before);
    // The product document has no place for it: such a file is not a valid product.
    expect(ProductDocumentSchema.safeParse({ ...p, personaCheck: confirm(p) }).success).toBe(false);
    expect(ProductDocumentSchema.safeParse({ ...p, revision: { ...p.revision, personaCheck: confirm(p) } }).success).toBe(false);
  });

  it("never made is 'required'; made on a map that has since changed is 'stale', and the two are told apart", () => {
    const p = approved();
    const check = confirm(p);
    expect(codes(resolvePersonaCheck(p, null))).toEqual(["persona_check_required"]);
    expect(codes(resolvePersonaCheck(p, undefined))).toEqual(["persona_check_required"]);

    const edited = updateCard(p, "persona-developer", { description: "Changed." });
    expect(codes(resolvePersonaCheck(edited, check))).toEqual(["stale_persona_check"]);
    expect(codes(resolvePersonaCheck(approveRevision(edited, APPROVAL), check))).toEqual(["stale_persona_check"]);
    expect(codes(resolvePersonaCheck(p, { ...check, productId: "another" }))).toEqual(["stale_persona_check"]);
    expect(codes(resolvePersonaCheck(p, { ...check, revision: 2 }))).toEqual(["stale_persona_check"]);
  });

  it("a change that only moves a card leaves it current", () => {
    const p = approved();
    expect(resolvePersonaCheck(setCardRow(p, "step-main-path", 2), confirm(p))).toEqual({ ok: true });
  });
});

describe("no slice without the people check", () => {
  it("selecting is refused without one, with a stale one, and with one made for another map", () => {
    const p = approved();
    expect(() => selectSlice(p, choice(p, null))).toThrow(/considered who else is relevant/);
    const edited = approveRevision(updateCard(p, "persona-developer", { description: "Changed." }), APPROVAL);
    expect(() => selectSlice(edited, choice(edited, confirm(p)))).toThrow(/confirmation .* was made on an earlier map/);
    expect(() => selectSlice(p, choice(p, { ...confirm(p), productId: "another" }))).toThrow(/earlier map|another product/);
  });

  it("with a current one the slice is selected, and the selection records under whose confirmation", () => {
    const p = approved();
    const selection = selectSlice(p, choice(p, confirm(p, "Zoe")));
    expect(selection.personaCheck).toEqual({ confirmedBy: "Zoe", confirmedAt: "2026-10-02T08:00:00.000Z" });
    expect(resolveSelection(p, selection).ok).toBe(true);
    expect(buildExecutionBrief(p, selection).ok).toBe(true);
  });

  it("the approval gate still comes first: on a proposed map neither the check nor a selection can be made", () => {
    const proposed = loadFixture();
    expect(() => confirm(proposed)).toThrow(/not approved/);
    expect(() => selectSlice(proposed, choice(proposed, null))).toThrow(/not approved/);
  });

  it("a selection that records no confirmation is not a selection: stale, and nothing is exported from it", () => {
    const p = approved();
    const { personaCheck: _dropped, ...withoutCheck } = selectSlice(p, choice(p, confirm(p)));
    const resolved = resolveSelection(p, withoutCheck);
    expect(resolved).toMatchObject({ ok: false, issues: [{ code: "stale_selection", path: "selection.personaCheck" }] });
    expect(codes(buildExecutionBrief(p, withoutCheck))).toEqual(["stale_selection"]);
    // Such a record is what a work-state file from before this gate holds: it still loads, and it is shown as stale.
    expect(validateWorkState({ workStateVersion: 1, selection: withoutCheck }).ok).toBe(true);
  });
});

describe("the work-state file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "asm-check-"));
    await fs.writeFile(path.join(dir, "asm.product.yaml"), fixtureText());
    process.env.ASM_PRODUCT_FILE = path.join(dir, "asm.product.yaml");
  });
  afterEach(async () => {
    delete process.env.ASM_PRODUCT_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps the check next to the selection, in a fixed order, and reads it back", async () => {
    const p = approved();
    const personaCheck = confirm(p);
    const selection = selectSlice(p, choice(p, personaCheck));
    expect((await saveWorkState({ workStateVersion: WORK_STATE_VERSION, selection, personaCheck })).ok).toBe(true);
    const text = await fs.readFile(path.join(dir, "asm.work-state.json"), "utf8");
    expect(Object.keys(JSON.parse(text))).toEqual(["workStateVersion", "personaCheck", "selection"]);
    expect(await loadWorkState()).toEqual({ ok: true, state: { workStateVersion: 1, personaCheck, selection } });
    expect(await fs.readFile(path.join(dir, "asm.product.yaml"), "utf8")).toBe(fixtureText());
  });

  it("refuses a check without a name, with an unknown field or with a malformed fingerprint", () => {
    const check = confirm(approved());
    for (const bad of [{ ...check, confirmedBy: " " }, { ...check, complete: true }, { ...check, mapFingerprint: "xyz" }])
      expect(validateWorkState({ workStateVersion: 1, personaCheck: bad }).ok).toBe(false);
    expect(validateWorkState({ workStateVersion: 1, personaCheck: check }).ok).toBe(true);
  });
});

describe("only a human can say it", () => {
  it("no agent output, review output or proposal has a field for it", () => {
    const check = confirm(approved());
    const output = { summary: "", goal: null, personas: [], needs: [], steps: [], assignments: [], moves: [], unresolvedQuestions: [] };
    expect(AgentOutputSchema.safeParse(output).success).toBe(true);
    for (const key of ["personaCheck", "personasComplete", "allPersonasFound"]) {
      expect(AgentOutputSchema.safeParse({ ...output, [key]: check }).success, key).toBe(false);
      expect(AgentReviewOutputSchema.safeParse({ summary: "", findings: [], [key]: true }).success, key).toBe(false);
      expect(
        MapPatchSchema.safeParse({ patchVersion: 1, provider: "x", baseFingerprint: "00000000", baseRevision: 1, summary: "", operations: [], [key]: check }).success,
        key,
      ).toBe(false);
    }
  });

  it("the guide never treats the people on the map as complete on its own: the step waits for the human", () => {
    const p = approved();
    const g = deriveGuide(p, null);
    expect(g.currentStepId).toBe("people_check");
    expect(g.steps.find((s) => s.id === "people_check")!.purpose).toContain("ASM cannot know");
    expect(deriveGuide(p, null, confirm(p)).currentStepId).toBe("select");
  });

  it("a stale check is shown as stale on its step, not as never made", () => {
    const p = approved();
    const check = confirm(p);
    const again = approveRevision(updateCard(p, "persona-developer", { description: "Changed." }), APPROVAL);
    const stale = deriveGuide(again, null, check).steps.find((s) => s.id === "people_check")!;
    expect(stale.status).toBe("current");
    expect(stale.stale).toContain("earlier map");
    expect(deriveGuide(again, null, null).steps.find((s) => s.id === "people_check")!.stale).toBeUndefined();
  });
});
