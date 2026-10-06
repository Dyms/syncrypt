// Review 3 shared fixtures (no tests here).
import { createSyncEngine, type SyncEngine, type SafeSyncOptions } from "../../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../../src/testing/index.js";

/** Runs `hold` before a manifest PUT lands: what lets a fork go unseen. */
export class InterleavingStorage extends MemoryStorage {
  hold: ((key: string) => Promise<void>) | null = null;
  override async put(key: string, data: Uint8Array, opts?: Parameters<MemoryStorage["put"]>[2]) {
    if (this.hold !== null && key.startsWith("manifests/")) {
      const h = this.hold;
      this.hold = null;
      await h(key);
    }
    return super.put(key, data, opts);
  }
}

export interface Device {
  id: string;
  engine: SyncEngine;
  vault: MemoryVault;
  log: MemoryLog;
  state: MemoryStateStore;
}

export const clock = new FixedClock();

export function device(
  storage: MemoryStorage,
  id: string,
  safeSync?: SafeSyncOptions,
  syncable?: (p: string) => boolean,
): Device {
  const vault = new MemoryVault();
  if (syncable !== undefined) (vault as unknown as { syncable: (p: string) => boolean }).syncable = syncable;
  const log = new MemoryLog();
  const state = new MemoryStateStore();
  return {
    id,
    engine: createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock,
      log,
      state,
      deviceId: id,
      storagePrefix: "",
      ...(safeSync !== undefined ? { safeSync } : {}),
    }),
    vault,
    log,
    state,
  };
}

/** Every text anywhere on the device: vault (any path) and trash. */
export function everywhere(d: Device): string[] {
  const out = d.vault.paths().map((p) => d.vault.getText(p) ?? "");
  for (const t of d.vault.trashed) out.push(new TextDecoder().decode(t.data));
  return out;
}

export function tick(seconds = 10): void {
  clock.advance(seconds);
}

/** A user save: a fresh mtime, so the hash cache cannot vouch for it. */
export function write(d: Device, path: string, text: string): void {
  clock.advance(3);
  d.vault.now = clock.now();
  d.vault.setFile(path, text);
}
