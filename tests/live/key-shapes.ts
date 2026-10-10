/**
 * The shapes of real provider keys, and the check every paid live record goes
 * through before it is written. It looks for real key shapes and for the
 * values of the keys in the environment, not for any word with "sk-" or "or-"
 * in it: the External-QA transcripts say "like-for-like-auto". Shared with the
 * scan of committed files (tests/agent/committed-secrets.test.ts).
 *
 * What it does not see: a key in a shape not listed here that is not set in
 * this environment, and a key split across lines.
 */
export const REAL_KEY_SHAPES = [
  /sk-ant-api\d\d-[A-Za-z0-9_-]{40,}/, // Anthropic
  /sk-or-v1-[0-9a-f]{32,}/, // OpenRouter
  /sk-proj-[A-Za-z0-9_-]{40,}/, // OpenAI project key
  /sk-[A-Za-z0-9]{40,}/, // OpenAI legacy key: no hyphen after sk-; no word boundary, a key can follow "cache_"
];

export const KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;

export const matchesRealKeyShape = (text: string) => REAL_KEY_SHAPES.some((shape) => shape.test(text));

/** Writes a record of a paid run as JSON, only after the check; nothing is written when the check refuses. */
export async function writeCheckedRecord(file: string, record: unknown, env: Record<string, string | undefined> = process.env) {
  const { promises: fs } = await import("node:fs");
  const text = JSON.stringify(record, null, 2);
  assertNoSecretInRecord(text, env);
  await fs.writeFile(file, text);
}

/** Copies an artifact of a paid run (an accepted map) only after the same check as the records (review round 3 on 198b1f9). */
export async function copyCheckedArtifact(from: string, to: string, env: Record<string, string | undefined> = process.env) {
  const { promises: fs } = await import("node:fs");
  const text = await fs.readFile(from, "utf8");
  assertNoSecretInRecord(text, env);
  await fs.writeFile(to, text);
}

/** Throws, without repeating any key, when a record holds a real key shape or the value of a key set in `env`. */
export function assertNoSecretInRecord(text: string, env: Record<string, string | undefined> = process.env) {
  if (matchesRealKeyShape(text)) throw new Error("the record holds text in the shape of a provider key; it is not written");
  for (const name of KEY_NAMES) {
    const value = env[name]?.trim();
    if (value && value.length >= 16 && text.includes(value)) throw new Error(`the record holds the value of ${name}; it is not written`);
  }
}
