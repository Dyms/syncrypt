// The shared Config Sync profile (ADR-0024).
//
// WHICH `.obsidian` files travel is a decision about the vault, not about this
// machine — but it used to live in Syncrypt's own `data.json`, which is
// deliberately never synced because it holds the storage keys (ADR-0016). So
// every device had to be ticked by hand, and the profiles drifted apart. That
// drift is exactly the shape that produced the data-loss defect in ADR-0022.
//
// The categories and the opted-in plugin list therefore move into an ordinary
// synced vault file. The keys stay in data.json, where they were. So does the
// master switch: a device decides FOR ITSELF whether it takes part in config
// sync at all, and only then does it obey the shared list.

import {
  SECRET_BEARING_PLUGINS,
  SHARED_CONFIG_SYNC_FILE,
  type ConfigSyncSettings,
} from "./config-sync.js";

/** The shared file. An ordinary synced file — encrypted, hashed, versioned. */
export const SHARED_CONFIG_SYNC_PATH = SHARED_CONFIG_SYNC_FILE;

/** The categories that travel. `enabled` is NOT one of them, by design. */
export interface SharedConfigSync {
  version: 1;
  categories: {
    appearance: boolean;
    app: boolean;
    hotkeys: boolean;
    themes: boolean;
    snippets: boolean;
    corePlugins: boolean;
    communityPluginsList: boolean;
  };
  plugins: string[];
}

const CATEGORY_KEYS = [
  "appearance",
  "app",
  "hotkeys",
  "themes",
  "snippets",
  "corePlugins",
  "communityPluginsList",
] as const;

type CategoryKey = (typeof CATEGORY_KEYS)[number];

/** Read the travelling part out of the live settings. */
export function sharedFrom(cs: ConfigSyncSettings): SharedConfigSync {
  const categories = {} as SharedConfigSync["categories"];
  for (const key of CATEGORY_KEYS) categories[key] = cs[key];
  return { version: 1, categories, plugins: [...cs.plugins].sort() };
}

/**
 * Serialize canonically: fixed key order, sorted plugin list, one trailing
 * newline. Two devices that agree MUST produce byte-identical files — the
 * engine dedups by content hash, so identical settings then cost no upload and
 * can never conflict with each other.
 */
export function serializeSharedConfig(shared: SharedConfigSync): string {
  const categories = CATEGORY_KEYS.map(
    (key) => `    ${JSON.stringify(key)}: ${JSON.stringify(shared.categories[key])}`,
  ).join(",\n");
  const plugins = [...shared.plugins]
    .sort()
    .map((id) => `    ${JSON.stringify(id)}`)
    .join(",\n");
  return (
    `{\n` +
    `  "version": 1,\n` +
    `  "categories": {\n${categories}\n  },\n` +
    `  "plugins": [${plugins === "" ? "" : `\n${plugins}\n  `}]\n` +
    `}\n`
  );
}

/**
 * Parse a shared file. Returns null for anything unusable — a settings file we
 * cannot read must leave this device's settings exactly as they are, never
 * reset them to defaults.
 */
export function parseSharedConfig(text: string): SharedConfigSync | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { version, categories, plugins } = raw as {
    version?: unknown;
    categories?: unknown;
    plugins?: unknown;
  };
  if (version !== 1) return null;
  if (typeof categories !== "object" || categories === null) return null;

  const out = {} as SharedConfigSync["categories"];
  for (const key of CATEGORY_KEYS) {
    const value = (categories as Record<string, unknown>)[key];
    // A missing category is not an error: a file written by a version that did
    // not have it yet must not silently turn it off. The caller keeps its own.
    if (typeof value !== "boolean") return null;
    out[key] = value;
  }
  const ids = Array.isArray(plugins)
    ? [...new Set(plugins.filter((x): x is string => typeof x === "string" && x !== ""))].sort()
    : [];
  return { version: 1, categories: out, plugins: ids };
}

export interface AdoptionResult {
  /** Did anything actually change on this device? */
  changed: boolean;
  /** Categories now ON that were OFF (by settings key). */
  enabledCategories: CategoryKey[];
  /** Categories now OFF that were ON. */
  disabledCategories: CategoryKey[];
  /** Plugin ids newly opted in here. */
  addedPlugins: string[];
  /** Plugin ids no longer opted in here. */
  removedPlugins: string[];
  /** Newly added ids known to keep secrets in data.json (RFC-0008 rail 1). */
  addedSecretBearing: string[];
}

/**
 * Adopt a shared profile into the live settings, IN PLACE — the vault adapter
 * holds this same object, so the new profile takes effect without a rebuild.
 * `enabled` is never touched: it is this device's own consent.
 */
export function adoptSharedConfig(
  cs: ConfigSyncSettings,
  shared: SharedConfigSync,
): AdoptionResult {
  const enabledCategories: CategoryKey[] = [];
  const disabledCategories: CategoryKey[] = [];
  for (const key of CATEGORY_KEYS) {
    if (cs[key] === shared.categories[key]) continue;
    (shared.categories[key] ? enabledCategories : disabledCategories).push(key);
  }
  const before = new Set(cs.plugins);
  const after = new Set(shared.plugins);
  const addedPlugins = [...after].filter((id) => !before.has(id)).sort();
  const removedPlugins = [...before].filter((id) => !after.has(id)).sort();

  for (const key of CATEGORY_KEYS) cs[key] = shared.categories[key];
  cs.plugins = [...after].sort();

  return {
    changed:
      enabledCategories.length > 0 ||
      disabledCategories.length > 0 ||
      addedPlugins.length > 0 ||
      removedPlugins.length > 0,
    enabledCategories,
    disabledCategories,
    addedPlugins,
    removedPlugins,
    addedSecretBearing: addedPlugins.filter((id) => SECRET_BEARING_PLUGINS.has(id)),
  };
}

/** Do the live settings already say exactly what this file says? */
export function sharedConfigMatches(
  cs: ConfigSyncSettings,
  shared: SharedConfigSync,
): boolean {
  return serializeSharedConfig(sharedFrom(cs)) === serializeSharedConfig(shared);
}
