import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoSecretInRecord } from "../live/key-shapes";

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

  it("passes the fake keys the tests and the bad-key server use", () => {
    expect(() => assertNoSecretInRecord("sk-this-key-cannot-work-0000000000000000 sk-test-0123456789abcdef0123456789abcdef", {})).not.toThrow();
  });
});
