// strategies/market-make/test/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["strategies/market-make/test/**/*.test.ts"],
    environment: "node",
  },
});
