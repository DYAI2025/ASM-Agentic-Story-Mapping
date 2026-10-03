import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/domain/**/*.test.ts", "tests/agent/**/*.test.ts", "tests/ui/**/*.test.ts"],
  },
});
