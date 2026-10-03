import { AgentOutputSchema } from "../domain/map-patch";
import { AgentReviewOutputSchema } from "../domain/review";
import { DEFAULT_TIMEOUT_MS, apiErrorMessage, parseModelJson, postJson } from "./http";
import { strictOutputSchema } from "./json-schema";
import { REVIEW_SYSTEM_PROMPT, SYSTEM_PROMPT, buildReviewMessage, buildUserMessage } from "./prompt";
import { ProviderError, type AgentProvider, type ReviewInput, type ReviewProvider, type StructureInput } from "./provider";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MAX_TOKENS = 16_000;

const PROPOSAL_FORMAT = { type: "json_schema", json_schema: { name: "asm_proposal", strict: true, schema: strictOutputSchema(AgentOutputSchema) } };
const REVIEW_FORMAT = { type: "json_schema", json_schema: { name: "asm_review", strict: true, schema: strictOutputSchema(AgentReviewOutputSchema) } };

type ChatBody = {
  choices?: Array<{ finish_reason?: string; error?: unknown; message?: { content?: unknown; refusal?: unknown } }>;
  error?: unknown;
};

/**
 * OpenRouter through its chat completions API, with the structured-output
 * format and `require_parameters` so a model that cannot honour the schema is
 * refused by OpenRouter instead of answering loosely. The model is whatever
 * `ASM_AGENT_MODEL` names: there is no default to guess. The key is sent in
 * one header and never logged or quoted. Output is returned raw for the domain.
 */
export class OpenRouterProvider implements AgentProvider, ReviewProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetch?: typeof globalThis.fetch;

  constructor(options: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch }) {
    if (!options.apiKey) throw new ProviderError("OPENROUTER_API_KEY is not set");
    if (!options.model) throw new ProviderError("ASM_AGENT_MODEL is not set; OpenRouter needs the model named, e.g. vendor/model");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetch = options.fetch;
    this.name = `openrouter (${this.model})`;
  }

  structure(input: StructureInput): Promise<unknown> {
    return this.ask(SYSTEM_PROMPT, buildUserMessage(input.context, input.product), PROPOSAL_FORMAT);
  }

  review(input: ReviewInput): Promise<unknown> {
    return this.ask(REVIEW_SYSTEM_PROMPT, buildReviewMessage(input.product), REVIEW_FORMAT);
  }

  private async ask(system: string, userMessage: string, format: typeof PROPOSAL_FORMAT): Promise<unknown> {
    const { status, body } = await postJson(
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}`, "x-title": "ASM" },
      {
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMessage },
        ],
        response_format: format,
        provider: { require_parameters: true },
        max_tokens: MAX_TOKENS,
      },
      { timeoutMs: this.timeoutMs, fetch: this.fetch, apiName: "OpenRouter", secrets: [this.apiKey] },
    );

    const message = apiErrorMessage(body, [this.apiKey]);
    if (status === 401) throw new ProviderError("OpenRouter rejected the credentials; check OPENROUTER_API_KEY");
    if (status === 429) throw new ProviderError("OpenRouter rate limit reached; try again shortly");
    if (status < 200 || status >= 300) throw new ProviderError(`OpenRouter API error ${status}: ${message ?? "no details"}`);
    if (message !== null) {
      // An error inside a 200: OpenRouter's own code, when it gives one.
      const code = (body as { error?: { code?: unknown } }).error?.code;
      throw new ProviderError(`OpenRouter API error${typeof code === "number" ? ` ${code}` : ""}: ${message}`);
    }

    const choice = ((body ?? {}) as ChatBody).choices?.[0];
    if (!choice) throw new ProviderError("the model returned no text output");
    if (choice.finish_reason === "error") {
      const detail = apiErrorMessage({ error: choice.error }, [this.apiKey]) ?? "no details";
      throw new ProviderError(`OpenRouter reported a model error: ${detail}`);
    }
    if (choice.finish_reason === "length") throw new ProviderError("the model's answer was cut off; try a shorter text");
    if (choice.finish_reason === "content_filter") throw new ProviderError("the model declined to process this text (content filter)");
    if (typeof choice.message?.refusal === "string" && choice.message.refusal !== "")
      throw new ProviderError("the model declined to process this text");
    const content = choice.message?.content;
    if (typeof content !== "string" || content === "") throw new ProviderError("the model returned no text output");
    return parseModelJson(content);
  }
}
