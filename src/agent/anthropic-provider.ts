import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { AgentOutputSchema } from "../domain/map-patch";
import { AgentReviewOutputSchema } from "../domain/review";
import { DEFAULT_TIMEOUT_MS, redactSecrets } from "./http";
import { REVIEW_SYSTEM_PROMPT, SYSTEM_PROMPT, buildReviewMessage, buildUserMessage } from "./prompt";
import { ProviderError, type AgentProvider, type ReviewInput, type ReviewProvider, type StructureInput } from "./provider";

export const DEFAULT_MODEL = "claude-opus-5-5";

/** The part of the SDK this provider uses; lets tests pass a stub instead of a network client. */
export type MessagesClient = Pick<Anthropic["beta"]["messages"], "parse">;

/**
 * No `fallbacks`: Anthropic offers a server-side retry on another model when
 * the safety classifiers decline. ASM's contract forbids a silent model
 * change (Confluence 14 §10), so a decline is a visible error instead.
 */
export function buildRequest(input: StructureInput, model: string) {
  return {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: buildUserMessage(input.context, input.product) }],
    output_config: {
      effort: "medium" as const,
      // The response is constrained to the agent output schema. The domain
      // validates it again; this constraint is not what the app relies on.
      format: betaZodOutputFormat(AgentOutputSchema),
    },
  };
}

export function buildReviewRequest(input: ReviewInput, model: string) {
  return {
    model,
    max_tokens: 16000,
    system: REVIEW_SYSTEM_PROMPT,
    messages: [{ role: "user" as const, content: buildReviewMessage(input.product) }],
    output_config: {
      effort: "medium" as const,
      // Constrained to the review output schema; the domain validates it again.
      format: betaZodOutputFormat(AgentReviewOutputSchema),
    },
  };
}

/**
 * Claude via the Anthropic API. Credentials come from the environment
 * (ANTHROPIC_API_KEY or another source the SDK resolves); none are stored here.
 */
export class AnthropicProvider implements AgentProvider, ReviewProvider {
  readonly name: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private client: MessagesClient | undefined;

  constructor(options: { model?: string; client?: MessagesClient; timeoutMs?: number } = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = options.client;
    this.name = `anthropic (${this.model})`;
  }

  structure(input: StructureInput): Promise<unknown> {
    return this.ask(buildRequest(input, this.model));
  }

  review(input: ReviewInput): Promise<unknown> {
    return this.ask(buildReviewRequest(input, this.model));
  }

  private async ask(request: ReturnType<typeof buildRequest> | ReturnType<typeof buildReviewRequest>): Promise<unknown> {
    // A deadline, and the SDK's bounded retries on transient failures. Credentials resolve from the environment.
    this.client ??= new Anthropic({ timeout: this.timeoutMs, maxRetries: 2 }).beta.messages;

    let response;
    try {
      response = await this.client.parse(request);
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError)
        throw new ProviderError("Anthropic rejected the credentials; check ANTHROPIC_API_KEY");
      if (error instanceof Anthropic.RateLimitError)
        throw new ProviderError("Anthropic rate limit reached; try again shortly");
      if (error instanceof Anthropic.APIConnectionTimeoutError)
        throw new ProviderError(`Anthropic timed out after ${this.timeoutMs} ms; try again or shorten the text`);
      if (error instanceof Anthropic.APIError)
        throw new ProviderError(redactSecrets(`Anthropic API error ${error.status ?? ""}: ${error.message}`.trim()));
      throw new ProviderError(redactSecrets(error instanceof Error ? error.message : String(error)));
    }

    if (response.stop_reason === "refusal")
      throw new ProviderError("the model declined to process this text");
    if (response.stop_reason === "max_tokens")
      throw new ProviderError("the model's answer was cut off; try a shorter text");

    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") throw new ProviderError("the model returned no text output");
    try {
      // Returned raw: the domain decides whether this is valid output.
      return JSON.parse(text.text);
    } catch {
      throw new ProviderError("the model's output was not valid JSON");
    }
  }
}
