// Obsidian configuration sync (RFC-0008). Opt-in, explicit, and narrow: only
// the paths listed here ever leave `.obsidian`, and three of them can never be
// synced no matter what the settings say.
//
// Deliberately NOT synced (RFC-0008 non-goal): plugin code. Plugins are
// installed and updated by Obsidian and BRAT; a second writer would fight
// those updates and silently roll versions back. Only their *settings* travel.
//
// The engine treats these files like any other: content-hashed, encrypted,
// conflicts surfaced. A conflict on a plugin's data.json produces a conflicted
// copy the plugin cannot read (RFC-0008 §Safety rails 3) — the user merges by
// hand, which is acceptable because settings rarely change on two devices at
// the same moment.

export const OBSIDIAN_DIR = ".obsidian";

export interface ConfigSyncSettings {
  /** Master switch; everything below is inert while this is false. */
  enabled: boolean;
  /** appearance.json — theme choice, font sizes, enabled snippets. */
  appearance: boolean;
  /** app.json — editor and file-handling options. Device-ish; off by default. */
  app: boolean;
  /** hotkeys.json */
  hotkeys: boolean;
  /** themes/** — installed themes (CSS, no code execution beyond styling). */
  themes: boolean;
  /** snippets/** — CSS snippets. */
  snippets: boolean;
  /** core-plugins.json — which built-in plugins are on. */
  corePlugins: boolean;
  /** community-plugins.json — WHICH third-party plugins are enabled (not their code). */
  communityPluginsList: boolean;
  /** Plugin ids whose data.json travels. Per-plugin opt-in (RFC-0008). */
  plugins: string[];
}

export const DEFAULT_CONFIG_SYNC: ConfigSyncSettings = {
  enabled: false,
  appearance: true,
  app: false,
  hotkeys: true,
  themes: true,
  snippets: true,
  corePlugins: true,
  communityPluginsList: true,
  plugins: [],
};

/** Syncrypt's own id — its data.json holds storage keys (ADR-0016). */
export const SYNCRYPT_PLUGIN_ID = "syncrypt";

/**
 * Syncrypt's own SHARED settings file (ADR-0024) — the categories and plugin
 * list below, as a synced vault file. Note the deliberate asymmetry with the
 * line above: `plugins/syncrypt/data.json` never travels because it holds the
 * storage keys; this file travels because WHICH config files sync is a fact
 * about the vault, not about one machine.
 */
export const SHARED_CONFIG_SYNC_FILE = `${OBSIDIAN_DIR}/syncrypt-config-sync.json`;

/**
 * Never synced, whatever the settings say:
 * - Syncrypt's own data.json — it holds the storage credentials (ADR-0016).
 * - workspace state — pane layout is per-device by definition.
 * - the sync-trash — Syncrypt's own recycle bin (ADR-0010).
 */
export function hardExcluded(path: string): boolean {
  return (
    path === `${OBSIDIAN_DIR}/workspace.json` ||
    path === `${OBSIDIAN_DIR}/workspace-mobile.json` ||
    path === `${OBSIDIAN_DIR}/workspace.json.bak` ||
    path.startsWith(`${OBSIDIAN_DIR}/plugins/${SYNCRYPT_PLUGIN_ID}/`) ||
    path.startsWith(`${OBSIDIAN_DIR}/sync-trash/`)
  );
}

/**
 * Plugins known to keep API keys or passwords in their data.json. Enabling
 * one is allowed — it is the user's vault and their bucket — but the UI warns
 * first (RFC-0008 §Safety rails 1). The list is a courtesy, never a guarantee:
 * any plugin can store a secret.
 */
export const SECRET_BEARING_PLUGINS: ReadonlySet<string> = new Set([
  "obsidian-livesync",
  "remotely-save",
  "obsidian-git",
  "copilot",
  "smart-connections",
  "obsidian-textgenerator-plugin",
  "readwise-official",
  "todoist-sync-plugin",
  "obsidian-zotero-desktop-connector",
  "khoj",
]);

/** Is this `.obsidian` path one the current settings ask us to sync? */
export function configPathAllowed(path: string, cs: ConfigSyncSettings): boolean {
  if (!cs.enabled) return false;
  if (!path.startsWith(`${OBSIDIAN_DIR}/`)) return false;
  if (hardExcluded(path)) return false;

  const rest = path.slice(OBSIDIAN_DIR.length + 1);
  // Our own shared profile rides along with the master switch and nothing
  // else: a device that takes part in config sync must be able to receive it
  // before it has any categories to obey (ADR-0024).
  if (path === SHARED_CONFIG_SYNC_FILE) return true;
  if (rest === "appearance.json") return cs.appearance;
  if (rest === "app.json") return cs.app;
  if (rest === "hotkeys.json") return cs.hotkeys;
  if (rest === "core-plugins.json") return cs.corePlugins;
  if (rest === "community-plugins.json") return cs.communityPluginsList;
  if (rest.startsWith("themes/")) return cs.themes;
  if (rest.startsWith("snippets/")) return cs.snippets;

  // Third-party plugins: ONLY data.json, and only for opted-in ids.
  const plugin = /^plugins\/([^/]+)\/data\.json$/.exec(rest);
  if (plugin !== null) return cs.plugins.includes(plugin[1] ?? "");

  return false;
}

/**
 * May this `.obsidian` subfolder contain synced files? Used to prune the walk
 * so we never enumerate node_modules-sized plugin folders for nothing.
 */
export function configFolderWorthWalking(path: string, cs: ConfigSyncSettings): boolean {
  if (!cs.enabled) return false;
  if (path === OBSIDIAN_DIR) return true;
  if (!path.startsWith(`${OBSIDIAN_DIR}/`)) return false;
  if (hardExcluded(`${path}/`)) return false;

  const rest = path.slice(OBSIDIAN_DIR.length + 1);
  if (rest === "themes" || rest.startsWith("themes/")) return cs.themes;
  if (rest === "snippets" || rest.startsWith("snippets/")) return cs.snippets;
  if (rest === "plugins") return cs.plugins.length > 0;
  const plugin = /^plugins\/([^/]+)$/.exec(rest);
  if (plugin !== null) return cs.plugins.includes(plugin[1] ?? "");
  return false;
}
