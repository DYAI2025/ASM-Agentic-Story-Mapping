import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = 3311;

/** The browser tests edit a scratch copy, never the canonical fixture. */
export const E2E_PRODUCT_FILE = path.join(__dirname, ".e2e-tmp", "asm.product.yaml");

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
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { ASM_PRODUCT_FILE: E2E_PRODUCT_FILE },
  },
});
