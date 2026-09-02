// ADR-0046. Two more places that assumed ".obsidian/plugins/syncrypt".

import { describe, expect, it } from "vitest";

import { configPaths, DEFAULT_CONFIG_DIR } from "../src/config-sync.js";
import { withDefaults } from "../src/settings.js";

describe("the sync-state cache lives in OUR folder", () => {
  it("follows the client's own directory when it reports one", () => {
    const manual = configPaths(DEFAULT_CONFIG_DIR, ".obsidian/plugins/syncrypt-1.0.0-beta.11");
    expect(manual.stateFile).toBe(".obsidian/plugins/syncrypt-1.0.0-beta.11/sync-state.json");
  });

  it("follows the VAULT's config folder when it does not", () => {
    // The old constant put it under ".obsidian" even on a vault that does not
    // use that name — a phantom tree beside the real one.
    expect(configPaths(".obsidian-work").stateFile).toBe(
      ".obsidian-work/plugins/syncrypt/sync-state.json",
    );
    expect(configPaths(DEFAULT_CONFIG_DIR).stateFile).toBe(
      ".obsidian/plugins/syncrypt/sync-state.json",
    );
  });

  it("is inside the folder that is hard-excluded from sync", () => {
    // It must never travel: it is this device's cache of the base manifest.
    for (const p of [
      configPaths(DEFAULT_CONFIG_DIR),
      configPaths(".obsidian-work"),
      configPaths(DEFAULT_CONFIG_DIR, ".obsidian/plugins/syncrypt-1.0.0-beta.11"),
      configPaths(".my-config", ".my-config/plugins/Syncrypt-main"),
    ]) {
      expect(p.hardExcluded(p.stateFile), p.stateFile).toBe(true);
    }
  });
});

describe("the sync profile is validated like every other setting", () => {
  it("a non-array falls back instead of throwing inside unlock", () => {
    // `new ProfileMatcher` calls .map on these. A hand-edited or half-written
    // data.json used to make unlock fail with a TypeError and no way back.
    const s = withDefaults({ profile: { include: "**", exclude: 7 } });
    expect(Array.isArray(s.profile.include)).toBe(true);
    expect(Array.isArray(s.profile.exclude)).toBe(true);
    expect(s.profile.include.length).toBeGreaterThan(0);
  });

  it("keeps the string entries of a partly-corrupt array", () => {
    const s = withDefaults({ profile: { include: ["*.md", 42, null, "Attachments/**"] } });
    expect(s.profile.include).toEqual(["*.md", "Attachments/**"]);
  });

  it("an array with no usable entry falls back rather than syncing nothing", () => {
    const s = withDefaults({ profile: { include: [42, null] } });
    expect(s.profile.include).toEqual(withDefaults({}).profile.include);
  });

  it("a deliberately empty list is respected", () => {
    expect(withDefaults({ profile: { exclude: [] } }).profile.exclude).toEqual([]);
  });
});
