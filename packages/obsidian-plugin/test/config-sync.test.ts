// RFC-0008 safety rails, unit-tested: nothing leaves `.obsidian` unless the
// user asked for exactly that path, and three things never leave at all.

import { describe, expect, it } from "vitest";

import {
  configFolderWorthWalking,
  configPathAllowed,
  DEFAULT_CONFIG_SYNC,
  SECRET_BEARING_PLUGINS,
  type ConfigSyncSettings,
} from "../src/config-sync.js";

const on = (over: Partial<ConfigSyncSettings> = {}): ConfigSyncSettings => ({
  ...DEFAULT_CONFIG_SYNC,
  enabled: true,
  ...over,
});

describe("config sync is opt-in", () => {
  it("syncs nothing at all while disabled", () => {
    for (const path of [
      ".obsidian/appearance.json",
      ".obsidian/hotkeys.json",
      ".obsidian/themes/Minimal/theme.css",
      ".obsidian/plugins/dataview/data.json",
    ]) {
      expect(configPathAllowed(path, DEFAULT_CONFIG_SYNC), path).toBe(false);
    }
    expect(configFolderWorthWalking(".obsidian", DEFAULT_CONFIG_SYNC)).toBe(false);
  });

  it("carries only the categories that are switched on", () => {
    const cs = on({ appearance: true, hotkeys: false, themes: false, snippets: true });
    expect(configPathAllowed(".obsidian/appearance.json", cs)).toBe(true);
    expect(configPathAllowed(".obsidian/hotkeys.json", cs)).toBe(false);
    expect(configPathAllowed(".obsidian/themes/Minimal/theme.css", cs)).toBe(false);
    expect(configPathAllowed(".obsidian/snippets/mine.css", cs)).toBe(true);
    // app.json is off by default: device-specific values live there.
    expect(configPathAllowed(".obsidian/app.json", on())).toBe(false);
  });
});

describe("hard invariants (never synced, whatever the settings)", () => {
  const everything = on({
    app: true,
    plugins: ["syncrypt", "dataview", "obsidian-livesync"],
  });

  it("never carries Syncrypt's own data.json — it holds the storage keys", () => {
    expect(configPathAllowed(".obsidian/plugins/syncrypt/data.json", everything)).toBe(false);
    expect(configPathAllowed(".obsidian/plugins/syncrypt/main.js", everything)).toBe(false);
    expect(configFolderWorthWalking(".obsidian/plugins/syncrypt", everything)).toBe(false);
  });

  it("never carries window layout or the sync-trash", () => {
    expect(configPathAllowed(".obsidian/workspace.json", everything)).toBe(false);
    expect(configPathAllowed(".obsidian/workspace-mobile.json", everything)).toBe(false);
    expect(configPathAllowed(".obsidian/sync-trash/notes/a.md", everything)).toBe(false);
  });

  it("never carries plugin CODE — only each plugin's settings (RFC-0008 non-goal)", () => {
    expect(configPathAllowed(".obsidian/plugins/dataview/data.json", everything)).toBe(true);
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      expect(configPathAllowed(`.obsidian/plugins/dataview/${file}`, everything), file).toBe(false);
    }
  });
});

describe("per-plugin opt-in", () => {
  it("carries data.json only for plugins the user picked", () => {
    const cs = on({ plugins: ["dataview"] });
    expect(configPathAllowed(".obsidian/plugins/dataview/data.json", cs)).toBe(true);
    expect(configPathAllowed(".obsidian/plugins/templater/data.json", cs)).toBe(false);
    expect(configFolderWorthWalking(".obsidian/plugins/dataview", cs)).toBe(true);
    expect(configFolderWorthWalking(".obsidian/plugins/templater", cs)).toBe(false);
    // With no plugin opted in there is no reason to walk the folder at all.
    expect(configFolderWorthWalking(".obsidian/plugins", on())).toBe(false);
  });

  it("flags the plugins known to keep secrets so the UI can warn", () => {
    expect(SECRET_BEARING_PLUGINS.has("remotely-save")).toBe(true);
    expect(SECRET_BEARING_PLUGINS.has("obsidian-livesync")).toBe(true);
    expect(SECRET_BEARING_PLUGINS.has("dataview")).toBe(false);
  });
});

describe("paths outside .obsidian are none of this module's business", () => {
  it("leaves notes to the sync profile", () => {
    expect(configPathAllowed("notes/a.md", on())).toBe(false);
    expect(configPathAllowed(".hidden/x", on())).toBe(false);
  });
});
