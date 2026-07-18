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
