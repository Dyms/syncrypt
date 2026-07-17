// Migration preflight (M6): detect another sync system pointed at this vault
// or leftover LiveSync artifacts, and WARN — never auto-fix (prime directive:
// no surprises; the user decides). See docs/user-guide/migration-from-livesync.md.

import type { DataAdapterLike } from "./adapter-types.js";

export interface PreflightWarning {
  code: string;
  message: string;
}

const KNOWN_SYNC_PLUGINS = [
  { id: "obsidian-livesync", name: "Self-hosted LiveSync" },
  { id: "remotely-save", name: "Remotely Save" },
  { id: "obsidian-git", name: "Obsidian Git" },
] as const;

const COMMUNITY_PLUGINS = ".obsidian/community-plugins.json";

export async function migrationPreflight(
  adapter: DataAdapterLike,
): Promise<PreflightWarning[]> {
  const warnings: PreflightWarning[] = [];

  let enabled: string[] = [];
  if (await adapter.exists(COMMUNITY_PLUGINS)) {
    try {
      const parsed: unknown = JSON.parse(
        new TextDecoder().decode(new Uint8Array(await adapter.readBinary(COMMUNITY_PLUGINS))),
      );
      if (Array.isArray(parsed)) enabled = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // Unreadable plugin list — not our file to judge; just skip the check.
    }
  }

  for (const plugin of KNOWN_SYNC_PLUGINS) {
    const installed = await adapter.exists(`.obsidian/plugins/${plugin.id}`);
    if (enabled.includes(plugin.id)) {
      warnings.push({
        code: `${plugin.id}:enabled`,
        message:
          `${plugin.name} is ENABLED in this vault. Two sync systems on one vault ` +
          `will fight over files — disable it before syncing with Syncrypt ` +
          `(see the migration guide).`,
      });
    } else if (installed) {
      warnings.push({
        code: `${plugin.id}:leftovers`,
        message:
          `${plugin.name} leftovers found (.obsidian/plugins/${plugin.id}). It is ` +
          `disabled, but "start clean" is the safe default — consider removing ` +
          `them (see the migration guide).`,
      });
    }
  }
  return warnings;
}
