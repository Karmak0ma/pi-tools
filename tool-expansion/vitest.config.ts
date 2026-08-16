import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    passWithNoTests: true,
    testTimeout: 10_000,
  },
});
