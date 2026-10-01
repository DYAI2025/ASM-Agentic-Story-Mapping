import { resolveReview, type ReviewResult } from "../domain/review";
import type { ProductDocument } from "../domain/schema";
import { ProviderError, type ReviewProvider } from "./provider";

/**
 * Map -> validated review findings. Reads the map, writes nothing.
 * Whatever the provider returns goes through `resolveReview`; a provider
 * failure or an invalid answer yields issues, never partial findings.
 */
export async function buildReview(product: ProductDocument, provider: ReviewProvider): Promise<ReviewResult> {
  let raw: unknown;
  try {
    raw = await provider.review({ product });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { ok: false, issues: [{ code: "provider_error", path: provider.name, message: error.message }] };
  }
  return resolveReview(product, raw, provider.name);
}
