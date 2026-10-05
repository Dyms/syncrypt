// ADR-0076: "is this folder ours" (ADR-0042) ignores case. A leftover copy in
// "Syncrypt-old" was not ours to adoptSharedConfig or the vault listing, so a
// shared profile naming it uploaded its data.json — storage keys — while the
// settings UI, reading the manifest id, hid it from the person (audit №4, C7).

import { describe, expect, it } from "vitest";

import { configPaths, DEFAULT_CONFIG_SYNC, pluginFolderIsOurs } from "../src/config-sync.js";
import { adoptSharedConfig } from "../src/config-sync-file.js";
import { DEFAULT_PROFILE } from "../src/profile.js";
import { ObsidianVault } from "../src/vault-adapter.js";
import { MockDataAdapter } from "./mock-adapter.js";

describe("a Syncrypt folder whose name differs in case", () => {
  it("is ours by name when no manifest says otherwise", () => {
    for (const name of ["Syncrypt-old", "SYNCRYPT", "SyncRypt 1.0.0-beta.9"]) {
      expect(pluginFolderIsOurs(name, "")).toBe(true);
    }
    expect(pluginFolderIsOurs("dataview", "")).toBe(false);
  });

  it("is never adopted from a shared profile, nor listed for upload", async () => {
    const paths = configPaths(".obsidian", ".obsidian/plugins/syncrypt");
    const cs = { ...DEFAULT_CONFIG_SYNC, enabled: true, plugins: [] as string[] };
    adoptSharedConfig(cs, {
      version: 1,
      categories: {
        appearance: true,
        app: false,
        hotkeys: true,
        themes: true,
        snippets: true,
        corePlugins: true,
        communityPluginsList: true,
      },
      plugins: ["Syncrypt-old"],
    });
    const adapter = new MockDataAdapter();
    adapter.setFile(".obsidian/plugins/syncrypt/data.json", '{"s3":{"secretAccessKey":"LIVE"}}');
    adapter.setFile(".obsidian/plugins/Syncrypt-old/manifest.json", '{"id":"syncrypt"}');
    adapter.setFile(".obsidian/plugins/Syncrypt-old/data.json", '{"s3":{"secretAccessKey":"OLD"}}');
    const vault = new ObsidianVault(adapter, DEFAULT_PROFILE, cs, paths);
    const listed: string[] = [];
    for await (const p of vault.list()) listed.push(p);
    expect(cs.plugins).not.toContain("Syncrypt-old");
    expect(listed).not.toContain(".obsidian/plugins/Syncrypt-old/data.json");
  });
});
