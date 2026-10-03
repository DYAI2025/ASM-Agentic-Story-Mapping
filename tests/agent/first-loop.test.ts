import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeProvider } from "../../src/agent/fake-provider";
import { buildProposal } from "../../src/agent/narrative-builder";
import { buildReview } from "../../src/agent/reviewer";
import { buildExecutionBrief, exportBriefMarkdown } from "../../src/domain/brief";
import { fingerprint } from "../../src/domain/fingerprint";
import { applyMapPatch } from "../../src/domain/map-patch";
import { approveRevision } from "../../src/domain/operations";
import { buildReviewPatch, reviewNarrative } from "../../src/domain/review";
import type { ProductDocument } from "../../src/domain/schema";
import { proposeSlices } from "../../src/domain/slices";
import { WORK_STATE_VERSION, selectSlice } from "../../src/domain/work-state";
import { loadProduct, loadWorkState, saveProduct, saveWorkState, workStateFilePath } from "../../src/server/store";
import { fixtureText, peopleCheck } from "../domain/helpers";

const TRANSCRIPT = readFileSync(path.join(__dirname, "..", "fixtures", "workshop-transcript.txt"), "utf8");

/**
 * The first market-testable loop, end to end, against the file store:
 * transcript -> map proposal -> approve -> review -> slice candidates -> select -> export.
 * Every write below is one a human asked for.
 */
describe("transcript to work order", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "asm-loop-"));
    file = path.join(dir, "asm.product.yaml");
    await fs.writeFile(file, fixtureText());
    process.env.ASM_PRODUCT_FILE = file;
  });

  afterEach(async () => {
    delete process.env.ASM_PRODUCT_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const text = () => fs.readFile(file, "utf8");
  async function canon(): Promise<ProductDocument> {
    const stored = await loadProduct();
    if (!stored.ok) throw new Error(JSON.stringify(stored.issues));
    return stored.product;
  }
  async function save(product: ProductDocument) {
    const saved = await saveProduct(product);
    if (!saved.ok) throw new Error(JSON.stringify(saved.issues));
  }

  it("runs the whole loop and writes only at the human steps", async () => {
    const provider = new FakeProvider();

    // 1. Transcript -> map proposal. Nothing is written.
    const proposal = await buildProposal(await canon(), TRANSCRIPT, provider);
    if (!proposal.ok) throw new Error(JSON.stringify(proposal.issues));
    expect(await text()).toBe(fixtureText());

    // 2. A human accepts the proposal, then approves the narrative.
    const accepted = applyMapPatch(await canon(), proposal.patch);
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.issues));
    await save(accepted.product);
    expect((await canon()).revision).toEqual({ number: 2, status: "proposed" });
    await save(approveRevision(await canon(), { approvedBy: "Maya", approvedAt: "2026-10-02T08:00:00.000Z" }));

    // 3. Review. Deterministic and agent findings; the file does not change.
    const beforeReview = await text();
    const gaps = reviewNarrative(await canon());
    expect(gaps.filter((f) => f.code === "wcbc_without_outcome")).toHaveLength(6);
    const review = await buildReview(await canon(), provider);
    if (!review.ok) throw new Error(JSON.stringify(review.issues));
    expect(review.review.findings.length).toBeGreaterThan(0);
    expect(await text()).toBe(beforeReview);
    expect((await canon()).revision.status).toBe("approved");

    // 4. A human accepts one WCBC suggestion. That reopens the revision.
    const suggestion = review.review.findings.find((f) => f.operation.op === "add_wcbc")!;
    const reviewed = applyMapPatch(await canon(), buildReviewPatch(review.review, [suggestion.findingId]));
    if (!reviewed.ok) throw new Error(JSON.stringify(reviewed.issues));
    await save(reviewed.product);
    expect((await canon()).revision).toEqual({ number: 3, status: "proposed" });

    // 5. Slice candidates. Nothing is selected, and nothing can be until a human approves.
    const proposed = proposeSlices(await canon());
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.issues));
    expect(proposed.candidates.length).toBeGreaterThanOrEqual(2);
    expect(proposed.candidates.length).toBeLessThanOrEqual(3);
    expect((await loadWorkState())).toEqual({ ok: true, state: { workStateVersion: WORK_STATE_VERSION } });
    const choice = { candidateId: "slice-outcome-thread", selectedBy: "Maya", selectedAt: "2026-10-02T09:00:00.000Z" };
    await expect(async () => selectSlice(await canon(), { ...choice, mapFingerprint: fingerprint(await canon()), personaCheck: null })).rejects.toThrow(/not approved/);
    expect(buildExecutionBrief(await canon(), undefined)).toMatchObject({ ok: false, issues: [{ code: "selection_required" }] });

    await save(approveRevision(await canon(), { approvedBy: "Maya", approvedAt: "2026-10-02T08:30:00.000Z" }));
    expect(buildExecutionBrief(await canon(), undefined)).toMatchObject({ ok: false, issues: [{ code: "selection_required" }] });

    // 6. A human selects a slice. The selection goes to the work state; the product file keeps its bytes.
    const beforeSelect = await text();
    // Approved, but nobody has confirmed who else is relevant: no slice yet.
    await expect(async () => selectSlice(await canon(), { ...choice, mapFingerprint: fingerprint(await canon()), personaCheck: null })).rejects.toThrow(/considered who else is relevant/);
    const personaCheck = peopleCheck(await canon());
    const written = await saveWorkState({
      workStateVersion: WORK_STATE_VERSION,
      personaCheck,
      selection: selectSlice(await canon(), { ...choice, mapFingerprint: fingerprint(await canon()), personaCheck }),
    });
    if (!written.ok) throw new Error(JSON.stringify(written.issues));
    expect(await text()).toBe(beforeSelect);
    expect(beforeSelect).not.toMatch(/selectedSlice|selectedBy|candidateFingerprint|mapFingerprint/);
    expect(workStateFilePath()).toBe(path.join(dir, "asm.work-state.json"));
    const final = await canon();
    const work = await loadWorkState();
    if (!work.ok) throw new Error(JSON.stringify(work.issues));
    expect(work.state.selection).toMatchObject({ candidateId: "slice-outcome-thread", selectedBy: "Maya", revision: 3, mapFingerprint: fingerprint(final) });

    // 7. Export, from the approved canon plus the selection. The brief names the exact revision of the map it came from.
    const result = buildExecutionBrief(final, work.state.selection);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.brief.approvedContext.value).toMatchObject({ status: "VALUE_RESOLVED" });
    expect(result.brief.sourceMapRevision).toMatchObject({
      revision: 3,
      status: "approved",
      approvedBy: "Maya",
      approvedAt: "2026-10-02T08:30:00.000Z",
      mapFingerprint: fingerprint(final),
    });
    // The step the transcript added between "select" and "export" is skipped by this slice and named as such.
    expect(result.brief.inScope.map((s) => s.id)).toEqual(["step-main-path", "step-review-slices", "step-select-slice", "step-export-work"]);
    expect(result.brief.approvedContext.assumptions.join(" ")).toContain("[step-walk-through-the-slice-with-the-team]");
    expect(exportBriefMarkdown(result.brief)).toContain("## SOURCE MAP REVISION");
  });
});
