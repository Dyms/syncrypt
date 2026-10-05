// Migration preflight (M6): detect another sync system pointed at this vault
// or leftover LiveSync artifacts, and WARN — never auto-fix (prime directive:
// no surprises; the user decides). See docs/user-guide/migration-from-livesync.md.

import type { DataAdapterLike } from "./adapter-types.js";
import { configPaths, DEFAULT_CONFIG_DIR, type ConfigPaths } from "./config-sync.js";
import { EN_STRINGS, type Strings } from "./i18n.js";

export interface PreflightWarning {
  code: string;
  message: string;
}

const KNOWN_SYNC_PLUGINS = [
  { id: "obsidian-livesync", name: "Self-hosted LiveSync" },
  { id: "remotely-save", name: "Remotely Save" },
  { id: "obsidian-git", name: "Obsidian Git" },
] as const;

/**
 * Where to look. The vault decides what its config folder is called (ADR-0032)
 * and this check was written against the constant — so on a renamed folder it
 * found nothing and warned about nothing, for ever. The DEFAULT folder is
 * checked as well, the same way `hardExcluded` does it: if the configured name
 * is ever wrong, the classic location is still examined (ADR-0046).
 */
function roots(paths: ConfigPaths): string[] {
  return [...new Set([paths.dir, DEFAULT_CONFIG_DIR])];
}

export async function migrationPreflight(
  adapter: DataAdapterLike,
  t: Strings = EN_STRINGS,
  paths: ConfigPaths = configPaths(DEFAULT_CONFIG_DIR),
): Promise<PreflightWarning[]> {
  const warnings: PreflightWarning[] = [];
  const dirs = roots(paths);

  const enabledSet = new Set<string>();
  for (const root of dirs) {
    const listPath = `${root}/community-plugins.json`;
    if (!(await adapter.exists(listPath))) continue;
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder().decode(new Uint8Array(await adapter.readBinary(listPath))),
      );
      if (Array.isArray(parsed)) {
        for (const x of parsed) if (typeof x === "string") enabledSet.add(x);
      }
    } catch {
      // Unreadable plugin list — not our file to judge; just skip the check.
    }
  }
  const enabled = [...enabledSet];

  // Obsidian's own Sync is a CORE plugin: not in community-plugins.json, not
  // under plugins/. It was the one competing sync system this check could not
  // see (audit №4, A9; ADR-0076). core-plugins.json is an object of
  // id → enabled since Obsidian 1.x, and was an array of enabled ids before.
  for (const root of dirs) {
    if (await coreSyncEnabled(adapter, `${root}/core-plugins.json`)) {
      warnings.push({
        code: "obsidian-sync:enabled",
        message: t.migration.enabled("Obsidian Sync"),
      });
      break;
    }
  }

  for (const plugin of KNOWN_SYNC_PLUGINS) {
    let installed = false;
    for (const root of dirs) {
      if (await adapter.exists(`${root}/plugins/${plugin.id}`)) installed = true;
    }
    if (enabled.includes(plugin.id)) {
      warnings.push({
        code: `${plugin.id}:enabled`,
        message: t.migration.enabled(plugin.name),
      });
    } else if (installed) {
      warnings.push({
        code: `${plugin.id}:leftovers`,
        message: t.migration.leftovers(plugin.name, plugin.id),
      });
    }
  }
  return warnings;
}

async function coreSyncEnabled(adapter: DataAdapterLike, path: string): Promise<boolean> {
  if (!(await adapter.exists(path))) return false;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(new Uint8Array(await adapter.readBinary(path))),
    );
    if (Array.isArray(parsed)) return parsed.includes("sync");
    if (typeof parsed === "object" && parsed !== null) {
      return (parsed as Record<string, unknown>).sync === true;
    }
  } catch {
    // Unreadable — not ours to judge, as above.
  }
  return false;
}
