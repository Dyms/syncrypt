// RFC-0008 safety rails, unit-tested: nothing leaves `.obsidian` unless the
// user asked for exactly that path, and three things never leave at all.

import { describe, expect, it } from "vitest";

import {
  configPaths,
  DEFAULT_CONFIG_DIR,
  pluginFolderIsOurs,
  DEFAULT_CONFIG_SYNC,
  SECRET_BEARING_PLUGINS,
  type ConfigSyncSettings,
} from "../src/config-sync.js";

const on = (over: Partial<ConfigSyncSettings> = {}): ConfigSyncSettings => ({
  ...DEFAULT_CONFIG_SYNC,
  enabled: true,
  ...over,
});

/** The classic folder. The renamed-folder cases build their own. */
const P = configPaths(DEFAULT_CONFIG_DIR);

describe("config sync is opt-in", () => {
  it("syncs nothing at all while disabled", () => {
    for (const path of [
      ".obsidian/appearance.json",
      ".obsidian/hotkeys.json",
      ".obsidian/themes/Minimal/theme.css",
      ".obsidian/plugins/dataview/data.json",
    ]) {
      expect(P.allowed(path, DEFAULT_CONFIG_SYNC), path).toBe(false);
    }
    expect(P.worthWalking(".obsidian", DEFAULT_CONFIG_SYNC)).toBe(false);
  });

  it("carries only the categories that are switched on", () => {
    const cs = on({ appearance: true, hotkeys: false, themes: false, snippets: true });
    expect(P.allowed(".obsidian/appearance.json", cs)).toBe(true);
    expect(P.allowed(".obsidian/hotkeys.json", cs)).toBe(false);
    expect(P.allowed(".obsidian/themes/Minimal/theme.css", cs)).toBe(false);
    expect(P.allowed(".obsidian/snippets/mine.css", cs)).toBe(true);
    // app.json is off by default: device-specific values live there.
    expect(P.allowed(".obsidian/app.json", on())).toBe(false);
  });
});

describe("hard invariants (never synced, whatever the settings)", () => {
  const everything = on({
    app: true,
    plugins: ["syncrypt", "dataview", "obsidian-livesync"],
  });

  it("never carries Syncrypt's own data.json — it holds the storage keys", () => {
    expect(P.allowed(".obsidian/plugins/syncrypt/data.json", everything)).toBe(false);
    expect(P.allowed(".obsidian/plugins/syncrypt/main.js", everything)).toBe(false);
    expect(P.worthWalking(".obsidian/plugins/syncrypt", everything)).toBe(false);
  });

  it("never carries window layout or the sync-trash", () => {
    expect(P.allowed(".obsidian/workspace.json", everything)).toBe(false);
    expect(P.allowed(".obsidian/workspace-mobile.json", everything)).toBe(false);
    expect(P.allowed(".obsidian/sync-trash/notes/a.md", everything)).toBe(false);
  });

  it("never carries plugin CODE — only each plugin's settings (RFC-0008 non-goal)", () => {
    expect(P.allowed(".obsidian/plugins/dataview/data.json", everything)).toBe(true);
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      expect(P.allowed(`.obsidian/plugins/dataview/${file}`, everything), file).toBe(false);
    }
  });
});

describe("per-plugin opt-in", () => {
  it("carries data.json only for plugins the user picked", () => {
    const cs = on({ plugins: ["dataview"] });
    expect(P.allowed(".obsidian/plugins/dataview/data.json", cs)).toBe(true);
    expect(P.allowed(".obsidian/plugins/templater/data.json", cs)).toBe(false);
    expect(P.worthWalking(".obsidian/plugins/dataview", cs)).toBe(true);
    expect(P.worthWalking(".obsidian/plugins/templater", cs)).toBe(false);
    // With no plugin opted in there is no reason to walk the folder at all.
    expect(P.worthWalking(".obsidian/plugins", on())).toBe(false);
  });

  it("flags the plugins known to keep secrets so the UI can warn", () => {
    expect(SECRET_BEARING_PLUGINS.has("remotely-save")).toBe(true);
    expect(SECRET_BEARING_PLUGINS.has("obsidian-livesync")).toBe(true);
    expect(SECRET_BEARING_PLUGINS.has("dataview")).toBe(false);
  });
});

describe("paths outside .obsidian are none of this module's business", () => {
  it("leaves notes to the sync profile", () => {
    expect(P.allowed("notes/a.md", on())).toBe(false);
    expect(P.allowed(".hidden/x", on())).toBe(false);
  });
});

// ADR-0032. Obsidian lets a vault rename its config folder; the plugin assumed
// ".obsidian" and, on those vaults, Config Sync silently synced nothing.
describe("a vault whose config folder is not called .obsidian", () => {
  const R = configPaths(".my-config");
  const on = (over: Partial<typeof DEFAULT_CONFIG_SYNC> = {}) => ({
    ...DEFAULT_CONFIG_SYNC,
    enabled: true,
    ...over,
  });

  it("syncs the same files under the renamed folder", () => {
    expect(R.allowed(".my-config/appearance.json", on())).toBe(true);
    expect(R.allowed(".my-config/hotkeys.json", on())).toBe(true);
    expect(R.allowed(".my-config/snippets/mine.css", on())).toBe(true);
    expect(R.worthWalking(".my-config", on())).toBe(true);
    expect(R.allowed(R.sharedProfile, { ...DEFAULT_CONFIG_SYNC, enabled: true })).toBe(true);
    expect(R.sharedProfile).toBe(".my-config/syncrypt-config-sync.json");
  });

  it("this is EXACTLY what used to be broken: nothing matched at all", () => {
    // The old rules were about ".obsidian". Against a renamed vault they said
    // no to every path in it — a silent no-op, which is the worst kind.
    expect(P.allowed(".my-config/appearance.json", on())).toBe(false);
    expect(P.worthWalking(".my-config", on())).toBe(false);
  });

  it("does not leak the classic folder into a renamed vault's rules", () => {
    expect(R.allowed(".obsidian/appearance.json", on())).toBe(false);
    expect(R.inside(".obsidian/appearance.json")).toBe(false);
    expect(R.inside(".my-config")).toBe(true);
    expect(R.inside(".my-config/themes/x.css")).toBe(true);
    expect(R.inside(".my-config-other/x.json")).toBe(false);
  });

  it("KEEPS THE KEYS IN: hard exclusions cover the renamed folder AND the classic one", () => {
    // The one rule whose failure uploads storage credentials (ADR-0016). A
    // rules object protects its own folder and, belt and braces, the default
    // one — so a stale or wrong configDir cannot expose the classic location.
    for (const path of [
      "plugins/syncrypt/data.json",
      "plugins/syncrypt/sync-state.json",
      "sync-trash/notes/a.md",
      "workspace.json",
      "workspace-mobile.json",
    ]) {
      expect(R.hardExcluded(`.my-config/${path}`), path).toBe(true);
      expect(R.hardExcluded(`.obsidian/${path}`), path).toBe(true);
      expect(P.hardExcluded(`.obsidian/${path}`), path).toBe(true);
    }
    // Even asked directly, with the plugin opted in by id.
    expect(R.allowed(".my-config/plugins/syncrypt/data.json", on({ plugins: ["syncrypt"] }))).toBe(
      false,
    );
    expect(R.worthWalking(".my-config/plugins/syncrypt", on({ plugins: ["syncrypt"] }))).toBe(false);
  });

  it("a WRONG configDir fails in the safe direction: syncs nothing, leaks nothing", () => {
    // If the vault ever answers with the wrong folder, the rules simply match
    // no path in the real one. That is a silent no-op — annoying, and the
    // failure this ADR is fixing — never an upload of something private.
    const wrong = configPaths(".obsidian"); // real folder is .my-config
    for (const path of [
      ".my-config/appearance.json",
      ".my-config/plugins/syncrypt/data.json",
      ".my-config/workspace.json",
    ]) {
      expect(wrong.allowed(path, on({ plugins: ["syncrypt"] })), path).toBe(false);
    }
  });

  it("the trash follows the folder, so it is never walked or synced", () => {
    expect(R.syncTrash).toBe(".my-config/sync-trash");
    expect(R.worthWalking(".my-config/sync-trash", on())).toBe(false);
  });
});

describe("a configDir the vault answers badly", () => {
  it("blank, whitespace or slash-suffixed falls back instead of matching everything", () => {
    // A rule set built from "" would call every path in the vault a config
    // path and hand the whole vault to the config-sync allow-list.
    for (const bad of ["", "   ", "/", "//"]) {
      expect(configPaths(bad).dir, JSON.stringify(bad)).toBe(DEFAULT_CONFIG_DIR);
      expect(configPaths(bad).inside("notes/a.md"), JSON.stringify(bad)).toBe(false);
    }
    expect(configPaths(".my-config/").dir).toBe(".my-config");
    expect(configPaths(" .my-config ").dir).toBe(".my-config");
  });
});

// ADR-0034. Matching the folder name "syncrypt" protects a BRAT install and
// nothing else: unzip a release by hand and the folder is called
// "syncrypt-1.0.0-beta.9", whose data.json holds the storage credentials.
describe("the plugin's OWN folder, whatever it is called", () => {
  const MANUAL = ".obsidian/plugins/syncrypt-1.0.0-beta.9";
  const P2 = configPaths(DEFAULT_CONFIG_DIR, MANUAL);
  const on = () => ({ ...DEFAULT_CONFIG_SYNC, enabled: true, plugins: ["syncrypt-1.0.0-beta.9"] });

  it("KEEPS THE KEYS IN when installed by hand from a release zip", () => {
    expect(P2.hardExcluded(`${MANUAL}/data.json`)).toBe(true);
    expect(P2.hardExcluded(`${MANUAL}/sync-state.json`)).toBe(true);
    expect(P2.hardExcluded(`${MANUAL}/main.js`)).toBe(true);
    // Even asked directly, with that exact folder opted in by name.
    expect(P2.allowed(`${MANUAL}/data.json`, on())).toBe(false);
    expect(P2.worthWalking(MANUAL, on())).toBe(false);
  });

  it("this is EXACTLY what used to leak", () => {
    // The old rules knew only the conventional folder name.
    expect(P.hardExcluded(`${MANUAL}/data.json`)).toBe(false);
    expect(P.allowed(`${MANUAL}/data.json`, on())).toBe(true);
  });

  it("still protects the conventional folder, and does not over-reach", () => {
    expect(P2.hardExcluded(".obsidian/plugins/syncrypt/data.json")).toBe(true);
    expect(P2.hardExcluded(".obsidian/plugins/dataview/data.json")).toBe(false);
    // A sibling folder sharing the prefix is somebody else's plugin.
    expect(P2.hardExcluded(".obsidian/plugins/syncrypt-1.0.0-beta.9-fork/data.json")).toBe(false);
    expect(P2.ownPluginDir).toBe(MANUAL);
  });

  it("works together with a renamed config folder", () => {
    const both = configPaths(".my-config", ".my-config/plugins/Syncrypt-main");
    expect(both.hardExcluded(".my-config/plugins/Syncrypt-main/data.json")).toBe(true);
    expect(both.hardExcluded(".obsidian/plugins/syncrypt/data.json")).toBe(true);
    expect(both.allowed(".my-config/appearance.json", { ...DEFAULT_CONFIG_SYNC, enabled: true })).toBe(true);
  });

  it("a client that does not report its folder falls back, never to nothing", () => {
    for (const bad of [undefined, "", "   ", "/"]) {
      const p = configPaths(DEFAULT_CONFIG_DIR, bad);
      expect(p.ownPluginDir, JSON.stringify(bad)).toBe("");
      // The conventional location is still protected…
      expect(p.hardExcluded(".obsidian/plugins/syncrypt/data.json"), JSON.stringify(bad)).toBe(true);
      // …and an empty own-dir must not swallow the whole vault.
      expect(p.hardExcluded("notes/a.md"), JSON.stringify(bad)).toBe(false);
      expect(p.hardExcluded(".obsidian/appearance.json"), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("what the plugin list is allowed to offer", () => {
  it("recognizes us by the manifest, not by the folder name", () => {
    expect(pluginFolderIsOurs("syncrypt", "syncrypt")).toBe(true);
    expect(pluginFolderIsOurs("syncrypt-1.0.0-beta.9", "syncrypt")).toBe(true);
    expect(pluginFolderIsOurs("Syncrypt-main", "syncrypt")).toBe(true);
    expect(pluginFolderIsOurs("anything-at-all", "syncrypt")).toBe(true);
  });

  it("does not mistake somebody else for us", () => {
    expect(pluginFolderIsOurs("dataview", "dataview")).toBe(false);
    // A plugin that merely NAMES itself after us in its folder is still not us
    // once its manifest says otherwise.
    expect(pluginFolderIsOurs("syncrypt-companion", "syncrypt-companion")).toBe(false);
  });

  it("fails closed when the manifest could not be read", () => {
    expect(pluginFolderIsOurs("syncrypt-1.0.0-beta.9", "")).toBe(true);
    expect(pluginFolderIsOurs("syncrypt", "")).toBe(true);
    expect(pluginFolderIsOurs("dataview", "")).toBe(false);
  });
});
