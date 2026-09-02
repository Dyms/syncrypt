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

/**
 * What Obsidian calls the config folder when nobody has renamed it. Obsidian
 * lets a vault use any name (`Vault.configDir`), and until beta.10 this
 * constant was the only answer the plugin had — so on a renamed vault Config
 * Sync silently synced nothing at all.
 *
 * It survives as a DEFAULT and as a belt-and-braces value in `hardExcluded`,
 * never as "the" config folder.
 */
export const DEFAULT_CONFIG_DIR = ".obsidian";

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
 * Every path rule that depends on the config folder's NAME, built once from
 * that name.
 *
 * A factory rather than four functions taking a `configDir` argument, and
 * deliberately so: `hardExcluded` is the invariant that keeps the storage
 * credentials from ever being uploaded (ADR-0016), and a caller that forgot to
 * pass the folder name would still compile and would quietly protect the wrong
 * directory. Here there is nothing to forget — the rules do not exist apart
 * from the folder they are about.
 *
 * The same reasoning applies twice over (ADR-0034): the rule also has to know
 * where THIS plugin is actually installed. Matching the folder name "syncrypt"
 * protects a BRAT install and nothing else — unzip a release by hand and the
 * folder is called "syncrypt-1.0.0-beta.9", whose data.json holds the storage
 * credentials and was, until now, an ordinary syncable config file.
 */
export interface ConfigPaths {
  /** The vault's config folder, normalized, never empty. */
  readonly dir: string;
  /** Where THIS plugin is installed, as the client reported it; "" if unknown. */
  readonly ownPluginDir: string;
  /** The shared Config Sync profile inside it (ADR-0024). */
  readonly sharedProfile: string;
  /** Syncrypt's own recycle bin (ADR-0010 §1). Never synced, never walked. */
  readonly syncTrash: string;
  /**
   * The base-manifest cache (ADR-0011), inside OUR OWN plugin folder wherever
   * that is. It used to be a constant, so a vault with a renamed config folder
   * grew a phantom `.obsidian/plugins/syncrypt/` tree beside the real one, and
   * a hand-unzipped install kept its state outside its own directory — where a
   * reinstall would adopt a stranger's base manifest (ADR-0046).
   */
  readonly stateFile: string;
  /** Is this path the config folder itself, or something inside it? */
  inside(path: string): boolean;
  /**
   * Never synced, whatever the settings say:
   * - Syncrypt's own data.json — it holds the storage credentials (ADR-0016).
   * - workspace state — pane layout is per-device by definition.
   * - the sync-trash — Syncrypt's own recycle bin (ADR-0010).
   */
  hardExcluded(path: string): boolean;
  /** Is this config path one the current settings ask us to sync? */
  allowed(path: string, cs: ConfigSyncSettings): boolean;
  /** May this config subfolder contain synced files? Prunes the walk. */
  worthWalking(path: string, cs: ConfigSyncSettings): boolean;
}

export function configPaths(dir: string, ownPluginDir?: string): ConfigPaths {
  // A vault whose configDir is missing, blank, or slash-suffixed must not turn
  // into rules about "" — which would make every path in the vault "inside the
  // config folder" and hand the whole thing to the config-sync allow-list.
  const trimmed = dir.trim().replace(/\/+$/, "");
  const base = trimmed === "" ? DEFAULT_CONFIG_DIR : trimmed;

  const sharedProfile = `${base}/syncrypt-config-sync.json`;
  const syncTrash = `${base}/sync-trash`;
  // Our own folder if the client told us where it is; the conventional place
  // under the vault's OWN config folder otherwise — never the constant
  // ".obsidian" of a vault that does not use it (ADR-0046).
  // Where Obsidian actually put us (`Plugin.manifest.dir`). Normalized the same
  // way as the config folder, and simply absent on a client that does not
  // report it — in which case the conventional location below still stands.
  const ownDir = (ownPluginDir ?? "").trim().replace(/\/+$/, "");

  const inside = (path: string): boolean =>
    path === base || path.startsWith(`${base}/`);

  const hardExcluded = (path: string): boolean => {
    // Checked under the CONFIGURED folder and under the default one. If the
    // configured name is ever wrong — a stale setting, an Obsidian API that
    // answers differently than expected — the classic location stays
    // protected. Belt and braces on the one rule whose failure uploads keys.
    // Where we are actually installed, whatever that folder is called. This
    // is the case the folder-name rule below cannot see (ADR-0034).
    if (ownDir !== "" && (path === ownDir || path.startsWith(`${ownDir}/`))) return true;
    for (const root of new Set([base, DEFAULT_CONFIG_DIR])) {
      if (
        path === `${root}/workspace.json` ||
        path === `${root}/workspace-mobile.json` ||
        path === `${root}/workspace.json.bak` ||
        path.startsWith(`${root}/sync-trash/`)
      ) {
        return true;
      }
      // ANY folder whose name says Syncrypt, not only the exact one and not
      // only the live install: an old copy, a hand-unzipped
      // "syncrypt-1.0.0-beta.9", a "syncrypt-old" kept aside — each holds a
      // data.json with storage credentials in it, and each was uploadable
      // because the only two rules were `ownDir` and the exact string
      // (ADR-0042). This is the same predicate the settings UI already used to
      // decide the same question; it just was not asked here.
      const prefix = `${root}/plugins/`;
      if (path.startsWith(prefix)) {
        const folder = path.slice(prefix.length).split("/")[0] ?? "";
        if (folder !== path.slice(prefix.length) && pluginFolderIsOurs(folder, "")) return true;
      }
    }
    return false;
  };

  const allowed = (path: string, cs: ConfigSyncSettings): boolean => {
    if (!cs.enabled) return false;
    if (!path.startsWith(`${base}/`)) return false;
    if (hardExcluded(path)) return false;

    const rest = path.slice(base.length + 1);
    // Our own shared profile rides along with the master switch and nothing
    // else: a device that takes part in config sync must be able to receive it
    // before it has any categories to obey (ADR-0024).
    if (path === sharedProfile) return true;
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
  };

  const worthWalking = (path: string, cs: ConfigSyncSettings): boolean => {
    if (!cs.enabled) return false;
    if (path === base) return true;
    if (!path.startsWith(`${base}/`)) return false;
    if (hardExcluded(`${path}/`)) return false;

    const rest = path.slice(base.length + 1);
    if (rest === "themes" || rest.startsWith("themes/")) return cs.themes;
    if (rest === "snippets" || rest.startsWith("snippets/")) return cs.snippets;
    if (rest === "plugins") return cs.plugins.length > 0;
    const plugin = /^plugins\/([^/]+)$/.exec(rest);
    if (plugin !== null) return cs.plugins.includes(plugin[1] ?? "");
    return false;
  };

  const home = ownDir !== "" ? ownDir : `${base}/plugins/${SYNCRYPT_PLUGIN_ID}`;

  return {
    dir: base,
    ownPluginDir: ownDir,
    sharedProfile,
    syncTrash,
    stateFile: `${home}/sync-state.json`,
    inside,
    hardExcluded,
    allowed,
    worthWalking,
  };
}

/**
 * Is this plugin folder US, whatever the folder happens to be called?
 *
 * The config-sync list matches FOLDER names, because that is what appears in
 * the paths — but a folder called "syncrypt-1.0.0-beta.9" is still us, and
 * offering it would offer our own storage credentials (ADR-0034). Decided by
 * the manifest's id where there is one, and fails closed on the folder name
 * where the manifest could not be read.
 */
export function pluginFolderIsOurs(folderId: string, manifestId: string): boolean {
  if (manifestId !== "") return manifestId === SYNCRYPT_PLUGIN_ID;
  return folderId.startsWith(SYNCRYPT_PLUGIN_ID);
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
