import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The plugin's UI code imports `obsidian`, which exists only inside the
      // app. Tests get a small stand-in that models what that code uses.
      obsidian: fileURLToPath(
        new URL("./packages/obsidian-plugin/test/support/obsidian-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    // The planner property tests are pure CPU; keep the default timeout generous
    // for the fuzzed end-to-end runs.
    testTimeout: 60_000,
  },
});
