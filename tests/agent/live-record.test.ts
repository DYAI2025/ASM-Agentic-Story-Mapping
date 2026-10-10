import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KEY_NAMES, assertNoSecretInRecord, copyCheckedArtifact, writeCheckedRecord } from "../live/key-shapes";

/**
 * The records of the paid live runs (battery, smoke, intake) are checked for
 * keys before they are written. The check looks for real key shapes and for
 * the values of the keys in the environment, not for any word with "sk-" or
 * "or-" in it: the External-QA transcripts say "like-for-like-auto", and a
 * record that quotes them must not be lost after the run was paid for
 * (verifier round 1 on 69bf7d4).
 */
const FIXTURES = path.join(__dirname, "..", "live", "fixtures", "qa");

describe("a live record is checked for keys, not for words that look like them", () => {
  it("passes the External-QA transcripts, whose words include 'like-for-like-auto'", () => {
    for (const name of ["A3-meeting-transcript.txt", "A4-mid-5k.txt", "A4-large-near-limit.txt"]) {
      const text = readFileSync(path.join(FIXTURES, name), "utf8");
      expect(text).toContain("like-for-like-auto");
      expect(() => assertNoSecretInRecord(JSON.stringify({ snippet: text }), {})).not.toThrow();
    }
  });

  it("refuses a record with text in the shape of a real provider key, built at run time so this file holds none", () => {
    expect(() => assertNoSecretInRecord(`x ${"sk-ant-api03-"}${"C".repeat(60)} y`, {})).toThrow();
    expect(() => assertNoSecretInRecord(`x ${"sk-or-v1-"}${"c".repeat(64)} y`, {})).toThrow();
    // A legacy key right after a word character (review round 2 on e4fb12a): no word boundary is required.
    expect(() => assertNoSecretInRecord(`cache_${"sk-"}${"D".repeat(48)}`, {})).toThrow();
  });

  it("refuses a record holding the value of a key set in the environment, whatever its shape, without repeating it", () => {
    const value = "plain-looking-value-0123456789";
    let message = "";
    try {
      assertNoSecretInRecord(`a ${value} b`, { ANTHROPIC_API_KEY: value });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/ANTHROPIC_API_KEY/);
    expect(message).not.toContain(value);
  });

  it("copies an accepted map only after the same check (review round 3 on 198b1f9: a rationale can carry a key shape)", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "asm-artifact-")));
    try {
      await fs.writeFile(path.join(dir, "clean.yaml"), "goal: like-for-like-auto\n");
      await copyCheckedArtifact(path.join(dir, "clean.yaml"), path.join(dir, "clean-copy.yaml"));
      expect(await fs.readFile(path.join(dir, "clean-copy.yaml"), "utf8")).toBe("goal: like-for-like-auto\n");
      await fs.writeFile(path.join(dir, "leaky.yaml"), `rationale: ${"sk-ant-api03-"}${"E".repeat(60)}\n`);
      await expect(copyCheckedArtifact(path.join(dir, "leaky.yaml"), path.join(dir, "leaky-copy.yaml"))).rejects.toThrow();
      await expect(fs.access(path.join(dir, "leaky-copy.yaml"))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("checks the value of every provider key name, trimmed as the environment may hold it", () => {
    expect([...KEY_NAMES].sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]);
    const value = "value-of-a-key-0123456789";
    for (const name of KEY_NAMES) {
      expect(() => assertNoSecretInRecord(`x ${value} y`, { [name]: value }), name).toThrow();
      expect(() => assertNoSecretInRecord(`x ${value} y`, { [name]: `  ${value}\n` }), `${name} with spaces`).toThrow();
    }
  });

  it("writes a record only after the check, and nothing when the check refuses", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "asm-record-")));
    try {
      await writeCheckedRecord(path.join(dir, "ok.json"), { quote: "like-for-like-auto" });
      expect(JSON.parse(await fs.readFile(path.join(dir, "ok.json"), "utf8"))).toEqual({ quote: "like-for-like-auto" });
      await expect(writeCheckedRecord(path.join(dir, "leak.json"), { quote: `${"sk-ant-api03-"}${"F".repeat(60)}` })).rejects.toThrow();
      await expect(fs.access(path.join(dir, "leak.json"))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("passes the fake keys the tests and the bad-key server use", () => {
    expect(() => assertNoSecretInRecord("sk-this-key-cannot-work-0000000000000000 sk-test-0123456789abcdef0123456789abcdef", {})).not.toThrow();
  });
});
