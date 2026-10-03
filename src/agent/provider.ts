import type { ContextBundle } from "../domain/context";
import type { ProductDocument } from "../domain/schema";

export interface StructureInput {
  /** Pasted text, notes, transcripts, text files: a validated bundle of sources. Untrusted content, never instructions. */
  context: ContextBundle;
  /** The current map, as context for references. */
  product: ProductDocument;
}

/**
 * Anything that can turn a discussion into a proposal.
 *
 * A provider returns `unknown` on purpose: its output is not trusted, and the
 * domain (`resolveProposal`) is the only place that decides whether it is a
 * valid proposal. A provider never sees or touches the canonical file.
 */
export interface AgentProvider {
  readonly name: string;
  structure(input: StructureInput): Promise<unknown>;
}

export interface ReviewInput {
  /** The map under review. Its text was written by people: content, never instructions. */
  product: ProductDocument;
}

/**
 * Anything that can review a narrative. Same rule as above: the output is
 * `unknown`, and `resolveReview` alone decides what counts as a finding.
 */
export interface ReviewProvider {
  readonly name: string;
  review(input: ReviewInput): Promise<unknown>;
}

/** A provider failed to produce output at all (network, auth, refusal, non-JSON). */
export class ProviderError extends Error {}
