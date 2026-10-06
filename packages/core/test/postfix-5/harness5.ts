// Review 5 fixtures (no tests here).
import { MemoryStorage } from "../../src/testing/index.js";

/**
 * One-shot hooks on a device's NEXT manifest PUT, keyed by device id. The
 * hook runs before the PUT lands; the PUT then lands and the publisher
 * re-lists. This is what lets an unseen fork, or a publish that straddles
 * another device's put+re-list, happen deterministically.
 */
export class GatedStorage extends MemoryStorage {
  private readonly hooks = new Map<string, () => Promise<void>>();
  beforeManifestPut(device: string, hook: () => Promise<void>): void {
    this.hooks.set(device, hook);
  }
  override async put(key: string, data: Uint8Array, opts?: Parameters<MemoryStorage["put"]>[2]) {
    if (key.startsWith("manifests/")) {
      for (const [device, hook] of this.hooks) {
        if (key.endsWith(`-${device}.json`)) {
          this.hooks.delete(device);
          await hook();
          break;
        }
      }
    }
    return super.put(key, data, opts);
  }
}

/** A gate: `reached` resolves when the holder arrives, it waits for `open()`. */
export function gate(): { reached: Promise<void>; hook: () => Promise<void>; open: () => void } {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (arrive = r));
  const released = new Promise<void>((r) => (release = r));
  return {
    reached,
    hook: async () => {
      arrive();
      await released;
    },
    open: () => { release(); },
  };
}
