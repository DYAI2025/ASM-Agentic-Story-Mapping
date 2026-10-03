import { AgentOutputSchema } from "../domain/map-patch";
import { AgentReviewOutputSchema } from "../domain/review";
import { DEFAULT_TIMEOUT_MS, apiErrorMessage, parseModelJson, postJson, redactSecrets } from "./http";
import { strictOutputSchema } from "./json-schema";
import { REVIEW_SYSTEM_PROMPT, SYSTEM_PROMPT, buildReviewMessage, buildUserMessage } from "./prompt";
import { ProviderError, type AgentProvider, type ReviewInput, type ReviewProvider, type StructureInput } from "./provider";

/** The model the OpenAI documentation names as the one to start with (read 2026-10-03). `ASM_AGENT_MODEL` overrides. */
export const OPENAI_DEFAULT_MODEL = "gpt-6-astra";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
const MAX_OUTPUT_TOKENS = 16_000;

const PROPOSAL_FORMAT = { type: "json_schema", name: "asm_proposal", strict: true, schema: strictOutputSchema(AgentOutputSchema) };
const REVIEW_FORMAT = { type: "json_schema", name: "asm_review", strict: true, schema: strictOutputSchema(AgentReviewOutputSchema) };

type ResponsesBody = {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
  error?: unknown;
};

/**
 * OpenAI through the Responses API (`POST /v1/responses`), structured output
 * constrained to the proposal or review schema. The key comes from the server
 * environment and is sent in one header; it is never logged and never part of
 * a message. The output is returned raw: the domain validates it.
 */
export class OpenAIProvider implements AgentProvider, ReviewProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetch?: typeof globalThis.fetch;

  constructor(options: { apiKey: string; model?: string; baseUrl?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch }) {
    if (!options.apiKey) throw new ProviderError("OPENAI_API_KEY is not set");
    this.apiKey = options.apiKey;
    this.model = options.model ?? OPENAI_DEFAULT_MODEL;
    this.baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetch = options.fetch;
    this.name = `openai (${this.model})`;
  }

  structure(input: StructureInput): Promise<unknown> {
    return this.ask(SYSTEM_PROMPT, buildUserMessage(input.context, input.product), PROPOSAL_FORMAT);
  }

  review(input: ReviewInput): Promise<unknown> {
    return this.ask(REVIEW_SYSTEM_PROMPT, buildReviewMessage(input.product), REVIEW_FORMAT);
  }

  private async ask(instructions: string, userMessage: string, format: typeof PROPOSAL_FORMAT): Promise<unknown> {
    const { status, body } = await postJson(
      `${this.baseUrl}/responses`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        instructions,
        input: [{ role: "user", content: userMessage }],
        text: { format },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      },
      { timeoutMs: this.timeoutMs, fetch: this.fetch, apiName: "OpenAI", secrets: [this.apiKey] },
    );

    const message = apiErrorMessage(body, [this.apiKey]);
    if (status === 401) throw new ProviderError("OpenAI rejected the credentials; check OPENAI_API_KEY");
    if (status === 429) {
      // OpenAI answers an exhausted balance with 429 too; that is not something a retry fixes.
      const error = (body as { error?: { type?: unknown; code?: unknown } } | null)?.error;
      if (error?.type === "insufficient_quota" || error?.code === "credit_balance_exhausted")
        throw new ProviderError("OpenAI reports no credits remaining on this key (insufficient_quota); add credits or use another provider");
      throw new ProviderError("OpenAI rate limit reached; try again shortly");
    }
    if (status < 200 || status >= 300) throw new ProviderError(`OpenAI API error ${status}: ${message ?? "no details"}`);
    if (message !== null) throw new ProviderError(`OpenAI API error: ${message}`);

    const response = (body ?? {}) as ResponsesBody;
    if (response.status === "incomplete") {
      const reason = response.incomplete_details?.reason;
      if (reason === "content_filter") throw new ProviderError("the model declined to process this text (content filter)");
      throw new ProviderError("the model's answer was cut off; try a shorter text");
    }
    // Only a completed response is an answer; anything else with text in it is not (external review round 4).
    if (response.status !== "completed")
      throw new ProviderError(`the model's response did not complete (status ${redactSecrets(JSON.stringify(response.status ?? "missing"), [this.apiKey])})`);
    const content = (response.output ?? []).flatMap((item) => (item.type === "message" ? (item.content ?? []) : []));
    const refusal = content.find((block) => block.type === "refusal");
    if (refusal) throw new ProviderError("the model declined to process this text");
    const text = content.find((block) => block.type === "output_text" && typeof block.text === "string");
    if (!text?.text) throw new ProviderError("the model returned no text output");
    return parseModelJson(text.text, [this.apiKey]);
  }
}
