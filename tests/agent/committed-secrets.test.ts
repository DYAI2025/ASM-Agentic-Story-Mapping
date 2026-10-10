import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ASM-28 (no credentials in committed files): every file git tracks is read
 * and searched for text in the shape of a real provider key. The keys the
 * tests feed in are recognisably fake (`sk-test-…`, `sk-stub-…`) and do not
 * have those shapes. When the environment holds a provider key (a local live
 * run), its exact value must not be in any tracked file either.
 *
 * What this does not see: a key in a shape not listed here, a key split
 * across lines, binary files, and anything outside what git tracks.
 */
const ROOT = path.join(__dirname, "..", "..");
const REAL_KEY_SHAPES = [
  /sk-ant-api\d\d-[A-Za-z0-9_-]{40,}/, // Anthropic
  /sk-or-v1-[0-9a-f]{32,}/, // OpenRouter
  /sk-proj-[A-Za-z0-9_-]{40,}/, // OpenAI project key
  /\bsk-[A-Za-z0-9]{40,}/, // OpenAI legacy key: no hyphen after sk-
];
const matches = (text: string) => REAL_KEY_SHAPES.some((shape) => shape.test(text));

function trackedTextFiles(): { file: string; text: string }[] {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT }).toString("utf8").split("\0").filter(Boolean);
  return files.flatMap((file) => {
    const buffer = (() => {
      try {
        return readFileSync(path.join(ROOT, file));
      } catch {
        return null; // tracked but deleted in the working tree
      }
    })();
    if (!buffer || buffer.includes(0)) return []; // binary
    return [{ file, text: buffer.toString("utf8") }];
  });
}

describe("committed files hold no credentials", () => {
  it("the shapes catch a key of each provider (positive control, built at run time so this file holds none)", () => {
    const filler = (n: number, c = "A") => c.repeat(n);
    expect(matches(`x ${"sk-ant-api03-"}${filler(60)} y`)).toBe(true);
    expect(matches(`x ${"sk-or-v1-"}${filler(64, "a")} y`)).toBe(true);
    expect(matches(`x ${"sk-proj-"}${filler(60)} y`)).toBe(true);
    expect(matches(`x ${"sk-"}${filler(48)} y`)).toBe(true);
    // The fake keys the tests use are not caught.
    expect(matches("sk-test-0123456789abcdef0123456789abcdef")).toBe(false);
    expect(matches("sk-stub-e2e-0000000000000000000000")).toBe(false);
  });

  it("no tracked file holds text in the shape of a real provider key", () => {
    const files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(50);
    const hits = files.filter(({ text }) => matches(text)).map(({ file }) => file);
    expect(hits).toEqual([]);
  });

  it("no tracked file holds the value of a provider key set in this environment", () => {
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]
      .map((name) => process.env[name]?.trim())
      .filter((value): value is string => typeof value === "string" && value.length >= 16);
    const hits = trackedTextFiles().filter(({ text }) => keys.some((key) => text.includes(key))).map(({ file }) => file);
    expect(hits).toEqual([]);
  });

  it("the local environment file is not tracked", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT }).toString("utf8").split("\0");
    expect(tracked.filter((file) => /(^|\/)\.env(\.|$)/.test(file) && file !== ".env.example")).toEqual([]);
  });
});
