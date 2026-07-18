// M6 EXIT: encrypted two-device sync over a LIVE WebDAV server with
// conditionalWrites=false — manifest concurrency rides ENTIRELY on the
// ADR-0006 LIST protocol. Fuzzed convergence + ciphertext-only assertion.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";

import { openSyncEngine, type SyncEngine } from "@syncrypt/sdk";
import { FixedClock, MemoryStateStore, MemoryVault } from "@syncrypt/core/testing";
import { KEYFILE_KEY } from "@syncrypt/crypto";

import { WebDavStorage } from "../src/index.js";
import { startLocalDav, type LiveDav } from "./live-server.js";

const PASSPHRASE = "webdav e2e passphrase";
const KDF_TEST_PRESET = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const;

let dav: LiveDav;
beforeAll(async () => {
  dav = await startLocalDav();
});
afterAll(async () => {
  await dav.stop();
});

interface Device {
  engine: SyncEngine;
  vault: MemoryVault;
  clock: FixedClock;
}

describe("encrypted sync over live WebDAV (no conditional writes)", () => {
  it("two devices converge over fuzzed runs; the server stores only ciphertext", async () => {
    const storage = new WebDavStorage(dav.config);
    expect(storage.capabilities().conditionalWrites).toBe(false);

    const PATHS = ["a.md", "b.md", "dir/c.md"] as const;
    type Action =
      | { type: "write"; device: number; path: string; tag: number }
      | { type: "delete"; device: number; path: string }
      | { type: "sync"; device: number };
    const deviceArb = fc.integer({ min: 0, max: 1 });
    const actionArb: fc.Arbitrary<Action> = fc.oneof(
      { weight: 5, arbitrary: fc.record({ type: fc.constant("write" as const), device: deviceArb, path: fc.constantFrom(...PATHS), tag: fc.integer({ min: 0, max: 3 }) }) },
      { weight: 2, arbitrary: fc.record({ type: fc.constant("delete" as const), device: deviceArb, path: fc.constantFrom(...PATHS) }) },
      { weight: 3, arbitrary: fc.record({ type: fc.constant("sync" as const), device: deviceArb }) },
    );

    let counter = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { minLength: 4, maxLength: 10 }), async (actions) => {
        const prefix = `run-${++counter}`;
        const devices: Device[] = [];
        for (const id of ["dev-a", "dev-b"]) {
          const vault = new MemoryVault();
          const clock = new FixedClock();
          devices.push({
            engine: await openSyncEngine({
              storage,
              vault,
              passphrase: PASSPHRASE,
              deviceId: id,
              storagePrefix: prefix,
              state: new MemoryStateStore(),
              clock,
              safeSync: { bulkChangeMaxFraction: 1 },
              kdfDefaults: KDF_TEST_PRESET,
            }),
            vault,
            clock,
          });
        }
        const syncConfirming = async (d: Device): Promise<string> => {
          const r = await d.engine.sync();
          if (r.outcome !== "needs-confirmation") return r.outcome;
          return (await d.engine.confirmAndApply(await d.engine.dryRun())).outcome;
        };
        for (const action of actions) {
          const d = devices[action.device];
          if (d === undefined) continue;
          d.clock.advance(30);
          d.vault.now = d.clock.now();
          if (action.type === "write") {
            d.vault.setFile(action.path, action.tag < 2 ? `v${action.tag}` : `SECRET-${++counter}`);
          } else if (action.type === "delete") {
            await d.vault.delete(action.path);
          } else {
            await syncConfirming(d);
          }
        }
        let converged = false;
        for (let round = 0; round < 10 && !converged; round++) {
          const outcomes: string[] = [];
          for (const d of devices) {
            d.clock.advance(30);
            d.vault.now = d.clock.now();
            outcomes.push(await syncConfirming(d));
          }
          converged = outcomes.every((o) => o === "no-op");
        }
        expect(converged, "no fixpoint").toBe(true);
        const [a, b] = devices;
        if (a === undefined || b === undefined) return;
        expect(a.vault.paths()).toEqual(b.vault.paths());
        for (const p of a.vault.paths()) expect(a.vault.getText(p)).toBe(b.vault.getText(p));
      }),
      { numRuns: 6 },
    );

    // CIPHERTEXT-ONLY: every stored object is a SYNC blob or a keyfile.
    const decoder = new TextDecoder();
    let checked = 0;
    for await (const stat of storage.list("")) {
      const bytes = await storage.get(stat.key);
      const text = decoder.decode(bytes);
      if (stat.key.endsWith(KEYFILE_KEY)) {
        expect(text).toContain("argon2id");
        continue;
      }
      expect(decoder.decode(bytes.subarray(0, 4)), stat.key).toBe("SYNC");
      expect(text, stat.key).not.toContain("SECRET-");
      expect(stat.key, stat.key).not.toMatch(/\.md/); // no plaintext path in keys
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }, 300_000);
});
