import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@airwave/shared": new URL("../../packages/shared/src", import.meta.url).pathname,
    },
  },
  test: {
    // ws.ts reads window.location — the ws tests need a DOM.
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
