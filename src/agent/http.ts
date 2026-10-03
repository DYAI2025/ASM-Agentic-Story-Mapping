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
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out.replace(/\b(sk|or)-[A-Za-z0-9_-]{8,}/g, "[redacted]");
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
  options: { timeoutMs: number; fetch?: typeof globalThis.fetch; apiName: string; secrets?: readonly string[] },
): Promise<JsonResponse> {
  const redact = (text: string) => redactSecrets(text, options.secrets ?? []);
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
    throw new ProviderError(`${options.apiName} could not be reached: ${redact(error instanceof Error ? error.message : String(error))}`);
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

/** The message an API put in its error object, redacted; or a plain status when there is none. */
export function apiErrorMessage(body: unknown, secrets: readonly string[] = []): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return redactSecrets(error, secrets);
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string")
    return redactSecrets((error as { message: string }).message, secrets);
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
  const text = JSON.stringify(output) ?? "";
  for (const secret of secrets) {
    if (secret.length >= 4 && text.includes(secret))
      throw new ProviderError("the model's output contained a configured secret and was discarded");
  }
}
