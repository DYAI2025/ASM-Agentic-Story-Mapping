import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExecutionBrief, exportBriefJson, exportBriefMarkdown } from "../../src/domain/brief";
import { fingerprint } from "../../src/domain/fingerprint";
import { approveRevision, updateCard } from "../../src/domain/operations";
import { ProductDocumentSchema, type ProductDocument } from "../../src/domain/schema";
import { exportProductYaml } from "../../src/domain/serialize";
import { SLICE_DERIVATION_VERSION, candidateFingerprint, proposeSlices, type SliceCandidate } from "../../src/domain/slices";
import {
  WORK_STATE_VERSION,
  acceptValueException,
  resolveSelection,
  selectSlice,
  validateWorkState,
  valueStatus,
  type SliceSelection,
} from "../../src/domain/work-state";
import { loadProduct, loadWorkState, productFilePath, saveProduct, saveWorkState, workStateFilePath } from "../../src/server/store";
import { loadFixture, mutableFixture, peopleCheck } from "./helpers";

const APPROVAL = { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" };
const approved = (p: ProductDocument = loadFixture()) => approveRevision(p, APPROVAL);
const codes = (result: object) => ("issues" in result ? (result.issues as { code: string }[]) : []).map((i) => i.code);
const paths = (result: object) => ("issues" in result ? (result.issues as { path: string }[]) : []).map((i) => i.path);

function candidates(p: ProductDocument): SliceCandidate[] {
  const proposal = proposeSlices(p);
  if (!proposal.ok) throw new Error(JSON.stringify(proposal.issues));
  return proposal.candidates;
}

const choose = (p: ProductDocument, candidateId = "slice-outcome-thread") =>
  selectSlice(p, { candidateId, selectedBy: "Maya", selectedAt: "2026-10-02T09:00:00.000Z", mapFingerprint: fingerprint(p), personaCheck: peopleCheck(p) });

/** An approved map on which the shared-steps candidate references no need. */
function needless(): ProductDocument {
  const p = mutableFixture();
  for (const step of p.narrative) if (step.personaIds.length > 1) step.needIds = [];
  return approved(p);
}

const EXCEPTION = {
  rationale: "We need the hand-over points working before we can observe which need they serve.",
  acceptedBy: "Maya",
  acceptedAt: "2026-10-02T09:30:00.000Z",
};

describe("slice selection is work state, not product canon", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "asm-work-"));
    process.env.ASM_PRODUCT_FILE = path.join(dir, "asm.product.yaml");
  });

  afterEach(async () => {
    delete process.env.ASM_PRODUCT_FILE;
    delete process.env.ASM_WORK_STATE_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("selecting a slice does not change the product document", () => {
    const product = approved();
    const frozen = structuredClone(product);
    const before = exportProductYaml(product);
    const selection = choose(product);
    expect(product).toEqual(frozen);
    expect(exportProductYaml(product)).toBe(before);
    expect(fingerprint(product)).toBe(selection.mapFingerprint);
    // What comes back is a selection, not a product document.
    expect(ProductDocumentSchema.safeParse(selection).success).toBe(false);
    expect(Object.keys(selection)).not.toContain("narrative");
  });

  it("the selection is stored in its own file and the product file keeps its bytes", async () => {
    expect((await saveProduct(approved())).ok).toBe(true);
    const productBytes = await fs.readFile(productFilePath(), "utf8");
    expect(await loadWorkState()).toEqual({ ok: true, state: { workStateVersion: WORK_STATE_VERSION } });

    const stored = await loadProduct();
    if (!stored.ok) throw new Error(JSON.stringify(stored.issues));
    const selection = choose(stored.product);
    expect((await saveWorkState({ workStateVersion: WORK_STATE_VERSION, selection })).ok).toBe(true);

    expect(workStateFilePath()).toBe(path.join(dir, "asm.work-state.json"));
    expect(workStateFilePath()).not.toBe(productFilePath());
    expect(await fs.readFile(productFilePath(), "utf8")).toBe(productBytes);
    expect(productBytes).not.toMatch(/selectedSlice|selectedBy|candidateFingerprint|mapFingerprint/);
    expect(JSON.parse(await fs.readFile(workStateFilePath(), "utf8"))).toEqual({ workStateVersion: 1, selection });
    expect(await loadWorkState()).toEqual({ ok: true, state: { workStateVersion: 1, selection } });
  });

  it("the product schema has no place for a selection", () => {
    expect(Object.keys(ProductDocumentSchema.shape)).not.toContain("selectedSlice");
    expect(ProductDocumentSchema.safeParse({ ...approved(), selectedSlice: choose(approved()) }).success).toBe(false);
  });

  it("the work-state file can be placed elsewhere, and a broken one is reported, not ignored", async () => {
    process.env.ASM_WORK_STATE_FILE = path.join(dir, "elsewhere.json");
    expect(workStateFilePath()).toBe(path.join(dir, "elsewhere.json"));
    await fs.writeFile(workStateFilePath(), "{ not json");
    expect(codes(await loadWorkState())).toEqual(["work_state_unparseable"]);
    await fs.writeFile(workStateFilePath(), JSON.stringify({ workStateVersion: 1, selection: { candidateId: "slice-x" } }));
    expect((await loadWorkState()).ok).toBe(false);
    expect((await saveWorkState({ workStateVersion: 1, selection: { ...choose(approved()), selectedBy: " " } })).ok).toBe(false);
    expect(validateWorkState({ workStateVersion: 1, selection: { ...choose(approved()), stepIds: ["step-main-path"] } }).ok).toBe(false);
  });

  it("these tests write to a scratch directory, never beside the fixture", () => {
    expect(path.dirname(productFilePath())).toBe(dir);
    expect(path.dirname(workStateFilePath())).toBe(dir);
  });
});

describe("a selection goes stale", () => {
  it("is current on the exact map it was made on", () => {
    const product = approved();
    expect(resolveSelection(product, choose(product))).toMatchObject({ ok: true, candidate: { id: "slice-outcome-thread" } });
  });

  it("when the product revision or the map fingerprint changes", () => {
    const product = approved();
    const selection = choose(product);

    // A semantic edit, approved again: another revision and another fingerprint.
    const next = approveRevision(updateCard(product, "step-export-work", { description: "Changed after selection." }), APPROVAL);
    expect(next.revision.number).toBe(2);
    expect(resolveSelection(next, selection)).toMatchObject({ ok: false, issues: [{ code: "stale_selection", path: "selection.mapFingerprint" }] });
    expect(codes(buildExecutionBrief(next, selection))).toEqual(["stale_selection"]);

    // The same revision number with other content: the fingerprint alone gives it away.
    const edited = structuredClone(product);
    edited.narrative[0].title = "Edited by hand";
    expect(edited.revision.number).toBe(selection.revision);
    expect(paths(resolveSelection(edited, selection))).toEqual(["selection.mapFingerprint"]);
    expect(codes(buildExecutionBrief(edited, selection))).toEqual(["stale_selection"]);

    // The same content under another revision number.
    expect(paths(resolveSelection(product, { ...selection, revision: 2 }))).toEqual(["selection.mapFingerprint"]);
    // Another product.
    expect(paths(resolveSelection(product, { ...selection, productId: "other-product" }))).toEqual(["selection.productId"]);
  });

  it("when the candidate fingerprint no longer matches", () => {
    const product = approved();
    const selection = { ...choose(product), candidateFingerprint: "00000000" };
    expect(resolveSelection(product, selection)).toMatchObject({ ok: false, issues: [{ code: "stale_selection", path: "selection.candidateFingerprint" }] });
    expect(buildExecutionBrief(product, selection)).toMatchObject({ ok: false, issues: [{ code: "stale_selection", path: "selection.candidateFingerprint" }] });

    // The fingerprint of another candidate of the same map does not pass either.
    const other = candidates(product).find((c) => c.id === "slice-shared-steps")!;
    expect(codes(buildExecutionBrief(product, { ...choose(product), candidateFingerprint: candidateFingerprint(other) }))).toEqual(["stale_selection"]);
    // Nor does a candidate id the map does not derive.
    expect(paths(resolveSelection(product, { ...choose(product), candidateId: "slice-made-up" }))).toEqual(["selection.candidateFingerprint"]);
  });

  it("when the derivation version no longer matches", () => {
    const product = approved();
    const selection = { ...choose(product), derivationVersion: SLICE_DERIVATION_VERSION + 1 };
    expect(resolveSelection(product, selection)).toMatchObject({ ok: false, issues: [{ code: "stale_selection", path: "selection.derivationVersion" }] });
    expect(buildExecutionBrief(product, selection)).toMatchObject({ ok: false, issues: [{ code: "stale_selection", path: "selection.derivationVersion" }] });
  });

  it("the candidate fingerprint is deterministic and covers everything the brief is built from", () => {
    const [candidate] = candidates(approved());
    expect(candidateFingerprint(candidate)).toMatch(/^[0-9a-f]{8}$/);
    expect(candidateFingerprint(structuredClone(candidate))).toBe(candidateFingerprint(candidate));
    expect(candidateFingerprint(candidates(approved())[0])).toBe(candidateFingerprint(candidate));

    const variants: SliceCandidate[] = [
      { ...candidate, id: "slice-other" },
      { ...candidate, title: "Other" },
      { ...candidate, goalId: "goal-other" },
      { ...candidate, stepIds: candidate.stepIds.slice(1) },
      { ...candidate, personaIds: candidate.personaIds.slice(1) },
      { ...candidate, needIds: candidate.needIds.slice(1) },
      { ...candidate, whyNow: [...candidate.whyNow, "x"] },
      { ...candidate, assumptions: [...candidate.assumptions, "x"] },
      { ...candidate, unresolvedQuestions: [...candidate.unresolvedQuestions, "x"] },
      { ...candidate, acceptanceCriteria: [...candidate.acceptanceCriteria, "x"] },
      { ...candidate, outOfScope: [...candidate.outOfScope, "x"] },
      { ...candidate, evidence: { ...candidate.evidence, openDecisionIds: [...candidate.evidence.openDecisionIds, "dec-x"] } },
      { ...candidate, evidence: { ...candidate.evidence, reviewGapIds: [...candidate.evidence.reviewGapIds, "gap-x"] } },
      { ...candidate, evidence: { ...candidate.evidence, worstCaseIds: [...candidate.evidence.worstCaseIds, "wcbc-x"] } },
      { ...candidate, flags: [{ code: "missing_need_reference", message: "x" }] },
    ];
    const prints = variants.map(candidateFingerprint);
    for (const print of prints) expect(print).not.toBe(candidateFingerprint(candidate));
    expect(new Set(prints).size).toBe(variants.length);
  });
});

describe("value-unresolved candidates", () => {
  function selectedNeedless(): [ProductDocument, SliceSelection] {
    const product = needless();
    return [product, choose(product, "slice-shared-steps")];
  }

  it("a candidate without a need can be viewed and compared", () => {
    const product = needless();
    const found = candidates(product);
    expect(found.map((c) => c.id)).toEqual(["slice-primary-persona", "slice-outcome-thread", "slice-shared-steps"]);
    const shared = found[2];
    expect(shared.needIds).toEqual([]);
    expect(shared.stepIds.length).toBeGreaterThan(0);
    expect(shared.evidence).toMatchObject({ needsServed: 0, totalNeeds: 6 });
    expect(shared.flags.map((f) => f.code)).toEqual(["missing_need_reference"]);
    expect(found.map((c) => valueStatus(product, c))).toEqual(["VALUE_RESOLVED", "VALUE_RESOLVED", "VALUE_UNRESOLVED"]);
  });

  it("a need reference only counts when the need is on the map", () => {
    const product = needless();
    expect(valueStatus(product, { id: "slice-x", needIds: ["need-ghost"] })).toBe("VALUE_UNRESOLVED");
    expect(valueStatus(product, { id: "slice-x", needIds: ["need-ghost", product.needs[0].id] })).toBe("VALUE_RESOLVED");
  });

  it("selecting it does not make it exportable: no work order without an explicit exception", () => {
    const [product, selection] = selectedNeedless();
    expect(selection.valueException).toBeUndefined();
    expect(resolveSelection(product, selection).ok).toBe(true);
    expect(valueStatus(product, { id: "slice-shared-steps", needIds: [] }, selection)).toBe("VALUE_UNRESOLVED");
    expect(buildExecutionBrief(product, selection)).toMatchObject({ ok: false, issues: [{ code: "value_unresolved", path: "selection.valueException" }] });
  });

  it("an empty exception rationale is rejected, and so is an unnamed human", () => {
    const [product, selection] = selectedNeedless();
    for (const rationale of ["", "   ", "\n\t"])
      expect(() => acceptValueException(product, selection, { ...EXCEPTION, rationale })).toThrow(/requires a rationale/);
    expect(() => acceptValueException(product, selection, { ...EXCEPTION, acceptedBy: " " })).toThrow(/name of the human/);
    // The stored form refuses it as well.
    expect(validateWorkState({ workStateVersion: 1, selection: { ...selection, valueException: { ...EXCEPTION, rationale: "  " } } }).ok).toBe(false);
    expect(codes(buildExecutionBrief(product, selection))).toEqual(["value_unresolved"]);
  });

  it("an explicit exception allows the export and is visible in the brief", () => {
    const [product, selection] = selectedNeedless();
    const accepted = acceptValueException(product, selection, EXCEPTION);
    expect(accepted).toEqual({ ...selection, valueException: EXCEPTION });
    expect(valueStatus(product, { id: "slice-shared-steps", needIds: [] }, accepted)).toBe("VALUE_EXCEPTION_ACCEPTED");

    const result = buildExecutionBrief(product, accepted);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.brief.approvedContext.value).toEqual({
      status: "VALUE_EXCEPTION_ACCEPTED",
      needIds: [],
      exception: EXCEPTION,
      note: expect.stringContaining("not proof that the slice has business value"),
    });
    expect(result.brief.needs).toEqual([]);
    expect(result.brief.openHumanDecisions.filter((d) => d.kind === "flag")).toHaveLength(1);
    expect(exportBriefJson(result.brief)).toContain(EXCEPTION.rationale);
    const markdown = exportBriefMarkdown(result.brief);
    expect(markdown).toContain("- Value: VALUE_EXCEPTION_ACCEPTED. Exception accepted by Maya at 2026-10-02T09:30:00.000Z");
    expect(markdown).toContain(`“${EXCEPTION.rationale}”`);
    expect(markdown).toContain("not proof that the slice has business value");
    expect(exportBriefJson(result.brief)).not.toMatch(/"(score|businessValue|valueScore)"/i);
  });

  it("an exception belongs to one selection: selecting again starts without it, and it cannot be moved", () => {
    const [product, selection] = selectedNeedless();
    const accepted = acceptValueException(product, selection, EXCEPTION);
    expect(choose(product, "slice-shared-steps").valueException).toBeUndefined();
    // After the map changes, the exception is as stale as the selection it sits on.
    const next = approveRevision(updateCard(product, "step-export-work", { description: "Changed." }), APPROVAL);
    expect(codes(buildExecutionBrief(next, accepted))).toEqual(["stale_selection"]);
    expect(() => acceptValueException(next, selection, EXCEPTION)).toThrow(/has changed/);
  });

  it("a candidate with a valid need exports without an exception", () => {
    const product = needless();
    const selection = choose(product, "slice-outcome-thread");
    const result = buildExecutionBrief(product, selection);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.brief.approvedContext.value.status).toBe("VALUE_RESOLVED");
    expect(result.brief.approvedContext.value.needIds.length).toBeGreaterThan(0);
    expect(result.brief.approvedContext.value).not.toHaveProperty("exception");
    expect(exportBriefMarkdown(result.brief)).toContain("- Value: VALUE_RESOLVED (");
    expect(() => acceptValueException(product, selection, EXCEPTION)).toThrow(/needs no value exception/);
  });
});
