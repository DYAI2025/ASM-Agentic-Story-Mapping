import path from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * The live provider smoke: the same app, a real model, run by hand with a key
 * in the environment (`npm run smoke:live`). Never part of CI. Two servers:
 * one with the configured provider and key, one with the same provider and a
 * key that cannot work, so the visible failure path is proven in the same run.
 *
 *   ASM_AGENT_PROVIDER=openai OPENAI_API_KEY=… npm run smoke:live
 */
const LIVE_PORT = 3312;
const BAD_KEY_PORT = 3313;
const provider = (process.env.ASM_AGENT_PROVIDER ?? "").trim().toLowerCase();
if (!["anthropic", "openai", "openrouter"].includes(provider))
  throw new Error("set ASM_AGENT_PROVIDER to anthropic, openai or openrouter for the live smoke");
const KEY_VAR = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" }[provider]!;
if (!process.env[KEY_VAR]) throw new Error(`${KEY_VAR} is not set in the environment`);

export const LIVE_PRODUCT_FILE = path.join(__dirname, ".e2e-tmp", "live.product.yaml");
export const BAD_KEY_PRODUCT_FILE = path.join(__dirname, ".e2e-tmp", "live-bad-key.product.yaml");

/** Only the variables the server needs; nothing else from the shell leaks into it. */
const serverEnv = (productFile: string, key: string) => ({
  ASM_PRODUCT_FILE: productFile,
  ASM_AGENT_PROVIDER: provider,
  ...(process.env.ASM_AGENT_MODEL ? { ASM_AGENT_MODEL: process.env.ASM_AGENT_MODEL } : {}),
  ...(process.env.ASM_AGENT_TIMEOUT_MS ? { ASM_AGENT_TIMEOUT_MS: process.env.ASM_AGENT_TIMEOUT_MS } : {}),
  ...(process.env.OPENAI_BASE_URL ? { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } : {}),
  [KEY_VAR]: key,
});

export default defineConfig({
  testDir: "tests/live",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 300_000,
  use: { viewport: { width: 1600, height: 1200 } },
  projects: [
    { name: "live", use: { baseURL: `http://127.0.0.1:${LIVE_PORT}` }, grep: /@live/ },
    { name: "bad-key", use: { baseURL: `http://127.0.0.1:${BAD_KEY_PORT}` }, grep: /@bad-key/ },
    // ASM-29: the External-QA intake battery against the same live server (`npm run battery:live`).
    { name: "battery", use: { baseURL: `http://127.0.0.1:${LIVE_PORT}` }, grep: /@battery/ },
  ],
  webServer: [
    {
      command: `npm run build && npm run start -- -p ${LIVE_PORT}`,
      url: `http://127.0.0.1:${LIVE_PORT}`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: serverEnv(LIVE_PRODUCT_FILE, process.env[KEY_VAR]!),
    },
    {
      command: `npm run start -- -p ${BAD_KEY_PORT}`,
      url: `http://127.0.0.1:${BAD_KEY_PORT}`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: serverEnv(BAD_KEY_PRODUCT_FILE, "sk-this-key-cannot-work-0000000000000000"),
    },
  ],
});
