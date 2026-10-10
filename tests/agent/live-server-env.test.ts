import { describe, expect, it } from "vitest";
import { ANTHROPIC_ENDPOINT, liveServerEnv } from "../live/server-env";

/**
 * The environment the live app is started with (playwright.live.config.ts).
 * Playwright passes the shell's environment on and Next fills names that are
 * not set from `.env.local`; what is set here wins over both. Review round 4
 * on e2ce76e: the endpoint has to be set too, or `.env.local` could send the
 * paid requests somewhere the guard's prices are not for.
 */
describe("the live server's environment", () => {
  it("names the workspace, the provider, the model, Anthropic's own endpoint and the key", () => {
    expect(liveServerEnv({ productFile: "/tmp/p.product.yaml", model: "claude-haiku-5-5", key: "k" })).toEqual({
      ASM_PRODUCT_FILE: "/tmp/p.product.yaml",
      ASM_AGENT_PROVIDER: "anthropic",
      ASM_AGENT_MODEL: "claude-haiku-5-5",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_API_KEY: "k",
    });
    expect(ANTHROPIC_ENDPOINT).toBe("https://api.anthropic.com");
  });

  it("passes a deadline on only when one is given", () => {
    expect(liveServerEnv({ productFile: "/p", model: "m", key: "k", timeoutMs: "300000" }).ASM_AGENT_TIMEOUT_MS).toBe("300000");
    expect("ASM_AGENT_TIMEOUT_MS" in liveServerEnv({ productFile: "/p", model: "m", key: "k" })).toBe(false);
  });
});
