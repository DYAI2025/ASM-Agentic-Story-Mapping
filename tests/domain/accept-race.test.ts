import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { structureWithMarkers } from "../../src/agent/fake-provider";
import { POST as acceptProposal } from "../../src/app/api/proposal/accept/route";
import { POST as approve } from "../../src/app/api/product/approve/route";
import { POST as peopleCheck } from "../../src/app/api/people-check/route";
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
    const [ra, rb] = await Promise.all([approve(request("/api/product/approve", { approvedBy: "Ada" })), acceptProposal(request("/api/proposal/accept", { patch }))]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    const stored = YAML.parse(await fs.readFile(productFilePath(), "utf8"));
    // Either the approval landed on revision 1 (the accept was stale), or the accept made revision 2 (the approval was refused).
    expect([stored.revision.number, stored.revision.status]).toSatisfy(([n, s]: [number, string]) => (n === 1 && s === "approved") || (n === 2 && s === "proposed"));
  });

  it("a people check and an accept at once: the check never lands on a map it was not made for", async () => {
    const approved = await approve(request("/api/product/approve", { approvedBy: "Ada" }));
    expect(approved.status).toBe(200);
    const live = YAML.parse(await fs.readFile(productFilePath(), "utf8"));
    const { fingerprint } = await import("../../src/domain/fingerprint");
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
