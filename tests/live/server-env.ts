/**
 * The environment the live app is started with for paid runs. Playwright
 * passes the shell's environment on, and Next fills names that are not set
 * from `.env.local`; what is set here wins over both. The guard's prices are
 * Anthropic's, for its own endpoint, so the endpoint is set too (review round
 * 4 on e2ce76e): `.env.local` cannot send the paid requests anywhere else.
 */
export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com";

export function liveServerEnv(options: { productFile: string; model: string; key: string; timeoutMs?: string }) {
  return {
    ASM_PRODUCT_FILE: options.productFile,
    ASM_AGENT_PROVIDER: "anthropic",
    ASM_AGENT_MODEL: options.model,
    ...(options.timeoutMs ? { ASM_AGENT_TIMEOUT_MS: options.timeoutMs } : {}),
    ANTHROPIC_BASE_URL: ANTHROPIC_ENDPOINT,
    ANTHROPIC_API_KEY: options.key,
  };
}
