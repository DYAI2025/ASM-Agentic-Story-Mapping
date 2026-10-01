import type { ProductDocument } from "../domain/schema";

export interface StructureInput {
  /** Pasted discussion, notes or transcript. Untrusted content, never instructions. */
  transcript: string;
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

/** A provider failed to produce output at all (network, auth, refusal, non-JSON). */
export class ProviderError extends Error {}
