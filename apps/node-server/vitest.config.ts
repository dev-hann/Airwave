import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // E2E uses real ffmpeg; keep files sequential to avoid device contention.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
