import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { structureWithMarkers } from "../../src/agent/fake-provider";
import { POST as acceptProposal } from "../../src/app/api/proposal/accept/route";
import { POST as approve } from "../../src/app/api/product/approve/route";
import { POST as peopleCheck } from "../../src/app/api/people-check/route";
import { POST as select } from "../../src/app/api/slices/select/route";
import { POST as exception } from "../../src/app/api/slices/exception/route";
import { approveRevision } from "../../src/domain/operations";
import { parseProductText } from "../../src/domain/serialize";
import { proposeSlices } from "../../src/domain/slices";
import { valueStatus } from "../../src/domain/work-state";
import { fingerprint } from "../../src/domain/fingerprint";
import { resolveProposal } from "../../src/domain/map-patch";
import { productFilePath, workStateFilePath } from "../../src/server/store";
import { fixtureText, loadFixture } from "./helpers";

/**
 * External review round 4 on 76ba4c2: two accepts built on the same revision,
 * both validated before either saved, both answered 200 and the second
 * overwrote the first. The whole load → check → save of a writing route now
 * runs inside the store's queue, so the second one re-reads and is stale.
 */
const request = (url: string, body: unknown) =>
  new Request(`http://127.0.0.1:3311${url}`, { method: "POST", headers: { host: "127.0.0.1:3311" }, body: JSON.stringify(body) });

describe("a value exception is bound to the selection the human saw (external review round 7)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "asm-exc-")));
    process.env.ASM_PRODUCT_FILE = path.join(dir, "asm.product.yaml");
    await fs.writeFile(process.env.ASM_PRODUCT_FILE, YAML.stringify(approveRevision(loadFixture(), { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" })));
  });
  afterEach(async () => {
    delete process.env.ASM_PRODUCT_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("an exception prepared for one unresolved slice does not land on another the selection moved to", async () => {
    const live = parseProductText(await fs.readFile(productFilePath(), "utf8"));
    if (!live.ok) throw new Error("fixture");
    const map = fingerprint(live.product);
    expect((await peopleCheck(request("/api/people-check", { confirmedBy: "Ada", mapFingerprint: map }))).status).toBe(200);
    const proposed = proposeSlices(live.product);
    if (!proposed.ok) throw new Error("no candidates");
    // The fixture's candidates all reference a need, so no exception is ever accepted here; the binding is checked first,
    // and that is what this test observes: a wrong candidate is refused as selection_changed, the right one reaches the domain.
    const ids = proposed.candidates.map((c) => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(proposed.candidates.every((c) => valueStatus(live.product, c) === "VALUE_RESOLVED")).toBe(true);
    const [x, y] = ids;
    expect((await select(request("/api/slices/select", { candidateId: x, selectedBy: "Ada", mapFingerprint: map }))).status).toBe(200);
    // The human reads X and writes a rationale; meanwhile the selection moves to Y.
    expect((await select(request("/api/slices/select", { candidateId: y, selectedBy: "Ben", mapFingerprint: map }))).status).toBe(200);
    const late = await exception(request("/api/slices/exception", { rationale: "X is worth building first.", acceptedBy: "Ada", candidateId: x, mapFingerprint: map }));
    expect(late.status).toBe(409);
    expect((await late.json()).issues[0].code).toBe("selection_changed");
    const work = JSON.parse(await fs.readFile(workStateFilePath(), "utf8"));
    expect(work.selection.candidateId).toBe(y);
    expect(work.selection.valueException).toBeUndefined();
    // Naming none is refused as unbound; naming the slice that is selected passes the binding and reaches the domain,
    // which refuses it for the fixture's own reason (the slice references a need).
    const unbound = await exception(request("/api/slices/exception", { rationale: "Y, then.", acceptedBy: "Ada", mapFingerprint: map }));
    expect(unbound.status).toBe(409);
    expect((await unbound.json()).issues[0].code).toBe("selection_changed");
    const right = await exception(request("/api/slices/exception", { rationale: "Y, then.", acceptedBy: "Ada", candidateId: y, mapFingerprint: map }));
    expect(right.status).toBe(409);
    const rightIssue = (await right.json()).issues[0];
    expect(rightIssue.code).toBe("exception_rejected");
    expect(rightIssue.message).toContain("needs no value exception");
  });
});

describe("a value exception is bound to the map and selection the human saw, across a change of the map (external review round 8)", () => {
  let dir: string;
  /** The fixture with every need reference removed from its steps: every candidate is value-unresolved. */
  const unresolvedFixture = () => {
    const p = structuredClone(loadFixture());
    for (const step of p.narrative) step.needIds = [];
    return p;
  };
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "asm-exc2-")));
    process.env.ASM_PRODUCT_FILE = path.join(dir, "asm.product.yaml");
    await fs.writeFile(process.env.ASM_PRODUCT_FILE, YAML.stringify(approveRevision(unresolvedFixture(), { approvedBy: "Ada", approvedAt: "2026-10-01T10:00:00.000Z" })));
  });
  afterEach(async () => {
    delete process.env.ASM_PRODUCT_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const current = async () => {
    const parsed = parseProductText(await fs.readFile(productFilePath(), "utf8"));
    if (!parsed.ok) throw new Error("product");
    return parsed.product;
  };

  it("after another browser changed, approved and reselected the same candidate id, the old exception is refused; a fresh one lands", async () => {
    const first = await current();
    const fp1 = fingerprint(first);
    expect((await peopleCheck(request("/api/people-check", { confirmedBy: "Ada", mapFingerprint: fp1 }))).status).toBe(200);
    const proposed = proposeSlices(first);
    if (!proposed.ok) throw new Error("no candidates");
    const x = proposed.candidates[0].id;
    expect(valueStatus(first, proposed.candidates[0])).toBe("VALUE_UNRESOLVED");
    expect((await select(request("/api/slices/select", { candidateId: x, selectedBy: "Ada", mapFingerprint: fp1 }))).status).toBe(200);

    // Browser B: changes the goal (new proposed revision), approves, confirms the people, selects x again on the new map.
    const changed = { ...(await current()), goal: { ...first.goal, statement: "A different goal altogether." } };
    const put = await import("../../src/app/api/product/route");
    const saved = await put.PUT(new Request("http://127.0.0.1:3311/api/product", { method: "PUT", headers: { host: "127.0.0.1:3311" }, body: YAML.stringify({ ...changed, revision: { number: changed.revision.number + 1, status: "proposed" } }) }));
    expect(saved.status).toBe(200);
    const second = await current();
    const fp2 = fingerprint(second);
    expect(fp2).not.toBe(fp1);
    expect((await approve(request("/api/product/approve", { approvedBy: "Ben", mapFingerprint: fp2 }))).status).toBe(200);
    // Approval changed the map (its revision record): the people check and the selection name the map as approved.
    const approvedMap = await current();
    const fp3 = fingerprint(approvedMap);
    expect((await peopleCheck(request("/api/people-check", { confirmedBy: "Ben", mapFingerprint: fp3 }))).status).toBe(200);
    expect((await select(request("/api/slices/select", { candidateId: x, selectedBy: "Ben", mapFingerprint: fp3 }))).status).toBe(200);

    // Browser A's exception, prepared on the first map, names x and fp1: refused, nothing recorded.
    const stale = await exception(request("/api/slices/exception", { rationale: "Built first because of the hand-over points.", acceptedBy: "Ada", candidateId: x, mapFingerprint: fp1 }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).issues[0].code).toBe("selection_changed");
    expect(JSON.parse(await fs.readFile(workStateFilePath(), "utf8")).selection.valueException).toBeUndefined();
    // Without a fingerprint it is refused too.
    expect((await exception(request("/api/slices/exception", { rationale: "r", acceptedBy: "Ada", candidateId: x }))).status).toBe(409);
    // On the map as it is now, it lands and the work order can be exported.
    const fresh = await exception(request("/api/slices/exception", { rationale: "Built first because of the hand-over points.", acceptedBy: "Ben", candidateId: x, mapFingerprint: fp3 }));
    expect(fresh.status).toBe(200);
    expect(JSON.parse(await fs.readFile(workStateFilePath(), "utf8")).selection.valueException.acceptedBy).toBe("Ben");
  });
});

describe("writing routes are transactions against the file as it is at commit time", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "asm-race-")));
    process.env.ASM_PRODUCT_FILE = path.join(dir, "asm.product.yaml");
    await fs.writeFile(process.env.ASM_PRODUCT_FILE, fixtureText());
  });
  afterEach(async () => {
    delete process.env.ASM_PRODUCT_FILE;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const proposal = (text: string) => {
    const product = loadFixture();
    const result = resolveProposal(product, structureWithMarkers(text, product), text, "test");
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.patch;
  };

  it("two accepts on the same revision: exactly one lands, the other is stale, and the file holds one revision 2", async () => {
    const a = proposal("Persona: Alpha — First. [roles: user]");
    const b = proposal("Persona: Beta — Second. [roles: user]");
    const [ra, rb] = await Promise.all([acceptProposal(request("/api/proposal/accept", { patch: a })), acceptProposal(request("/api/proposal/accept", { patch: b }))]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect((await loser.json()).issues[0].code).toBe("stale_patch");
    const stored = YAML.parse(await fs.readFile(productFilePath(), "utf8"));
    expect(stored.revision.number).toBe(2);
    const names = stored.personas.map((p: { name: string }) => p.name);
    expect(names.filter((n: string) => n === "Alpha" || n === "Beta")).toHaveLength(1);
  });

  it("an approval and an accept on the same revision: the one that lands second is refused, never silently merged", async () => {
    const patch = proposal("Persona: Gamma — Third. [roles: user]");
    const seen = fingerprint(loadFixture());
    const [ra, rb] = await Promise.all([approve(request("/api/product/approve", { approvedBy: "Ada", mapFingerprint: seen })), acceptProposal(request("/api/proposal/accept", { patch }))]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    const stored = YAML.parse(await fs.readFile(productFilePath(), "utf8"));
    // Either the approval landed on revision 1 (the accept was stale), or the accept made revision 2 (the approval was refused).
    expect([stored.revision.number, stored.revision.status]).toSatisfy(([n, s]: [number, string]) => (n === 1 && s === "approved") || (n === 2 && s === "proposed"));
  });

  it("an approval carries what the human saw: after an accept that opened revision 2, approving revision 1 is refused (external review round 7)", async () => {
    const seen = fingerprint(loadFixture());
    const accepted = await acceptProposal(request("/api/proposal/accept", { patch: proposal("Persona: Epsilon — Fifth. [roles: user]") }));
    expect(accepted.status).toBe(200);
    const late = await approve(request("/api/product/approve", { approvedBy: "Ada", mapFingerprint: seen }));
    expect(late.status).toBe(409);
    expect((await late.json()).issues[0].code).toBe("stale_approval");
    const stored = YAML.parse(await fs.readFile(productFilePath(), "utf8"));
    expect(stored.revision).toEqual({ number: 2, status: "proposed" });
    // Without saying what was seen, nothing is approved either.
    const blind = await approve(request("/api/product/approve", { approvedBy: "Ada" }));
    expect(blind.status).toBe(409);
    expect((await blind.json()).issues[0].code).toBe("stale_approval");
    expect(YAML.parse(await fs.readFile(productFilePath(), "utf8")).revision.status).toBe("proposed");
  });

  it("a people check and an accept at once: the check never lands on a map it was not made for", async () => {
    const approved = await approve(request("/api/product/approve", { approvedBy: "Ada", mapFingerprint: fingerprint(loadFixture()) }));
    expect(approved.status).toBe(200);
    const live = YAML.parse(await fs.readFile(productFilePath(), "utf8"));
    const { parseProductText } = await import("../../src/domain/serialize");
    const parsed = parseProductText(YAML.stringify(live));
    if (!parsed.ok) throw new Error("fixture");
    const mapFingerprint = fingerprint(parsed.product);
    const text = "Persona: Delta — Fourth. [roles: user]";
    const result = resolveProposal(parsed.product, structureWithMarkers(text, parsed.product), text, "test");
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const [rc, ra] = await Promise.all([
      peopleCheck(request("/api/people-check", { confirmedBy: "Ada", mapFingerprint })),
      acceptProposal(request("/api/proposal/accept", { patch: result.patch })),
    ]);
    // Two orders are possible, and both are honest:
    if (rc.status === 200) {
      // The check landed first, on the approved map it was made for; the accept then opened revision 2 and the check
      // is stale from here on (the existing stale mechanism), never merged into the new map.
      expect(ra.status).toBe(200);
      expect(JSON.parse(await fs.readFile(workStateFilePath(), "utf8")).personaCheck.mapFingerprint).toBe(mapFingerprint);
      expect(YAML.parse(await fs.readFile(productFilePath(), "utf8")).revision).toEqual({ number: 2, status: "proposed" });
    } else {
      // The accept landed first; the check was made for an approved map that is gone, and is refused.
      expect(rc.status).toBe(409);
      expect((await rc.json()).issues[0].code).toBe("people_check_rejected");
      expect(await fs.access(workStateFilePath()).then(() => true, () => false)).toBe(false);
    }
  });
});
