import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // See test-setup.ts: the suite must not inherit the host's subagent or
    // Herdr markers, or results depend on where the tests are launched.
    setupFiles: ["./src/test-setup.ts"],
  },
});
