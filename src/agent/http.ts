import { ProviderError } from "./provider";

export const DEFAULT_TIMEOUT_MS = 120_000;

/** A key never appears in a message, whatever an API echoes back. */
export function redactSecrets(text: string): string {
  return text.replace(/\b(sk|or)-[A-Za-z0-9_-]{8,}/g, "[redacted]");
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
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError"))
      throw new ProviderError(`${options.apiName} timed out after ${options.timeoutMs} ms; try again or shorten the text`);
    throw new ProviderError(`${options.apiName} could not be reached: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  } finally {
    clearTimeout(timer);
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

/** The message an API put in its error object, redacted; or a plain status when there is none. */
export function apiErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return redactSecrets(error);
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string")
    return redactSecrets((error as { message: string }).message);
  return null;
}

/** JSON text from a model: parsed, or a visible error. The domain decides whether it is valid output. */
export function parseModelJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("the model's output was not valid JSON");
  }
}
