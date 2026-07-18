import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    // The planner property tests are pure CPU; keep the default timeout generous
    // for the fuzzed end-to-end runs.
    testTimeout: 60_000,
  },
});
