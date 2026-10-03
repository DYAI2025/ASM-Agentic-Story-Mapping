import { ProviderError } from "./provider";

export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A key never appears in a message, whatever an API echoes back: the exact
 * configured values first (any shape, four characters or longer — a shorter
 * value would also be any ordinary word), then the common key patterns as a
 * second net (external review F4).
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    // Every spelling the secret can have inside text that was serialized once or twice before it got here
    // (an SDK's exception text, a status field through JSON.stringify): the raw value, its JSON-escaped form,
    // that form escaped again, and its URL-encoded form (external review round 10).
    const once = JSON.stringify(secret).slice(1, -1);
    const twice = JSON.stringify(once).slice(1, -1);
    for (const spelling of new Set([secret, once, twice, encodeURIComponent(secret)])) out = out.split(spelling).join("[redacted]");
  }
  return out.replace(/\b(sk|or)-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

/**
 * The one boundary every provider call crosses on its way out: whatever was
 * thrown inside — this module's own errors, an SDK's exception with upstream
 * text in it, a transport failure — leaves as a `ProviderError` whose message
 * went through the redactor. No adapter message is trusted to have done
 * that itself (external review round 10).
 */
export async function contained<T>(secrets: readonly string[], work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(redactSecrets(error instanceof ProviderError ? message : `the provider call failed: ${message}`, secrets));
  }
}

export type JsonResponse = { status: number; body: unknown };

/**
 * One JSON POST with a deadline. The only place a provider touches the
 * network. A failure to reach the API, or to get an answer in time, is a
 * `ProviderError` the caller shows; the status and body are returned for the
 * caller to judge, because every API has its own way of saying no.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: { timeoutMs: number; fetch?: typeof globalThis.fetch; apiName: string },
): Promise<JsonResponse> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const timedOut = (error: unknown) => controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (timedOut(error)) throw new ProviderError(`${options.apiName} timed out after ${options.timeoutMs} ms; try again or shorten the text`);
    throw new ProviderError(`${options.apiName} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The deadline covers the body as well: headers that arrive at once and a body that never does are a timeout too.
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch (error) {
    if (timedOut(error)) throw new ProviderError(`${options.apiName} timed out after ${options.timeoutMs} ms; try again or shorten the text`);
    parsed = null;
  } finally {
    clearTimeout(timer);
  }
  return { status: response.status, body: parsed };
}

/**
 * Whether an API put an error in its body: anything under `error` that is not
 * null or undefined, whatever shape it has. Presence is judged separately
 * from the message, so an error without a readable message is still an error
 * (external review round 11).
 */
export function hasApiError(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const error = (body as { error?: unknown }).error;
  return error !== null && error !== undefined;
}

/** The message an API put in its error object, or null when it has none readable. Redaction happens once, at `contained`. */
export function apiErrorMessage(body: unknown): string | null {
  if (!hasApiError(body)) return null;
  const error = (body as { error: unknown }).error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string")
    return (error as { message: string }).message;
  return null;
}

/** JSON text from a model: parsed, or a visible error. The domain decides whether it is valid output. */
export function parseModelJson(text: string, secrets: readonly string[] = []): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError("the model's output was not valid JSON");
  }
  refuseLeakedSecrets(parsed, secrets);
  return parsed;
}

/**
 * Model output that carries a configured secret never reaches the domain: a
 * validation message or an accepted rationale would otherwise carry it into
 * the response or the product file (external review round 8). The output is
 * discarded as a whole; nothing of it is quoted.
 */
export function refuseLeakedSecrets(output: unknown, secrets: readonly string[]): void {
  const live = secrets.filter((secret) => secret.length >= 4);
  if (live.length === 0) return;
  // Decoded values, not a re-serialization: JSON escaping would hide a secret that contains a quote or a
  // backslash (external review round 9). Keys are strings too.
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const secret of live) if (node.includes(secret)) throw new ProviderError("the model's output contained a configured secret and was discarded");
      return;
    }
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walk(key);
      walk(value);
    }
  };
  walk(output);
}
