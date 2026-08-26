import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@airwave/shared": new URL("../../packages/shared/src", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
