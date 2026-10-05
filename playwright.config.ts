import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = 3311;
/** ASM-29: the same build with the real openai adapter pointed at a scripted model (tests/e2e/model-stub-server.ts). */
export const REPAIR_PORT = 3314;
export const MODEL_STUB_PORT = 3315;
export const MODEL_STUB_KEY = "sk-stub-e2e-0000000000000000000000";

/** The browser tests edit a scratch copy, never the canonical fixture. */
export const E2E_PRODUCT_FILE = path.join(__dirname, ".e2e-tmp", "asm.product.yaml");
/** Where the app keeps the work state for that copy: beside it, by the store's default rule. */
export const E2E_WORK_STATE_FILE = path.join(__dirname, ".e2e-tmp", "asm.work-state.json");
/** The repair app's own workspace, so it never touches the files of the main app under test. */
export const E2E_REPAIR_PRODUCT_FILE = path.join(__dirname, ".e2e-tmp", "repair.product.yaml");
export const E2E_REPAIR_WORK_STATE_FILE = path.join(__dirname, ".e2e-tmp", "repair.work-state.json");

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1600, height: 1000 },
  },
  webServer: [
    {
      command: `npm run build && npm run start -- -p ${PORT}`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: false,
      timeout: 240_000,
      // The fake provider is forced so the browser tests never call a model.
      env: { ASM_PRODUCT_FILE: E2E_PRODUCT_FILE, ASM_AGENT_PROVIDER: "fake" },
    },
    {
      // No real model and no real key anywhere: a scripted model on localhost.
      command: "npx tsx tests/e2e/model-stub-server.ts",
      url: `http://127.0.0.1:${MODEL_STUB_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { STUB_PORT: String(MODEL_STUB_PORT), STUB_KEY: MODEL_STUB_KEY },
    },
    {
      command: `npm run start -- -p ${REPAIR_PORT}`,
      url: `http://127.0.0.1:${REPAIR_PORT}`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        ASM_PRODUCT_FILE: E2E_REPAIR_PRODUCT_FILE,
        ASM_AGENT_PROVIDER: "openai",
        ASM_AGENT_MODEL: "stub-model",
        OPENAI_API_KEY: MODEL_STUB_KEY,
        OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_STUB_PORT}/v1`,
      },
    },
  ],
});
