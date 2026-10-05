// StateStorePort over the plugin's own folder (ADR-0011): the base manifest
// survives restarts, so reopening Obsidian does not force a full reconcile.
// Deliberately a separate file from data.json — settings are user config,
// sync state is a cache.

import type { StateStorePort } from "@syncrypt/core";

import type { DataAdapterLike } from "./adapter-types.js";

export const DEFAULT_STATE_PATH = ".obsidian/plugins/syncrypt/sync-state.json";

export class AdapterStateStore implements StateStorePort {
  constructor(
    private readonly adapter: DataAdapterLike,
    private readonly path: string = DEFAULT_STATE_PATH,
  ) {}

  async load(): Promise<Uint8Array | null> {
    if (!(await this.adapter.exists(this.path))) return null;
    return new Uint8Array(await this.adapter.readBinary(this.path));
  }

  async save(data: Uint8Array): Promise<void> {
    const segments = this.path.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
    }
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(data);
    await this.adapter.writeBinary(this.path, buffer);
  }
}

/**
 * Give the pre-ADR-0065 state file to the location in use, once.
 *
 * Before ADR-0065 there was one `sync-state.json` per vault folder. The
 * location configured at the first unlock after upgrading is, for everyone
 * who did not change storage in between, the location that file describes;
 * it becomes that location's file. Nothing is done when the location already
 * has one, so this never overwrites a newer base with an older one.
 *
 * Someone who changed the storage settings and upgraded before unlocking
 * again hands the old base to the new location. That is the pre-ADR-0065
 * behaviour, for one unlock; ADR-0065 records it.
 */
export async function adoptLegacyState(
  adapter: DataAdapterLike,
  legacyPath: string,
  path: string,
): Promise<void> {
  if (legacyPath === path) return;
  if (await adapter.exists(path)) return;
  if (!(await adapter.exists(legacyPath))) return;
  await adapter.rename(legacyPath, path);
}
