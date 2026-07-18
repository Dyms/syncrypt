// M2 exit criteria, end to end: the real SyncEngine + real crypto.
// Storage holds ONLY ciphertext; a new device joins with just the passphrase;
// wrong passphrase and tampering fail closed; behavior matches M1 exactly.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  createSyncEngine,
  isSyncError,
  type CryptoPort,
  type SyncEngine,
} from "@syncrypt/core";
import {
  FixedClock,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "@syncrypt/core/testing";

import { KEYFILE_KEY, openVaultCrypto } from "../src/index.js";
import { TEST_PRESET } from "./params.js";

const PASSPHRASE = "correct horse battery staple";

interface Device {
  engine: SyncEngine;
  vault: MemoryVault;
  clock: FixedClock;
}

async function makeDevice(
  storage: MemoryStorage,
  id: string,
  passphrase = PASSPHRASE,
): Promise<Device> {
  const crypto: CryptoPort = await openVaultCrypto({
    storage,
    storagePrefix: "",
    passphrase,
    defaults: TEST_PRESET,
  });
  const vault = new MemoryVault();
  const clock = new FixedClock();
  const engine = createSyncEngine({
    storage,
    vault,
    crypto,
    clock,
    state: new MemoryStateStore(),
    deviceId: id,
    storagePrefix: "",
    safeSync: { bulkChangeMaxFraction: 1 },
  });
  return { engine, vault, clock };
}

const SECRET = "TOP-SECRET plaintext: the meeting is at dawn";
const SECRET_PATH = "Projects/secret-plan.md";

describe("encrypted two-device sync (M2)", () => {
  it("round-trips through ciphertext and leaves NO plaintext in storage", async () => {
    const storage = new MemoryStorage();
    const a = await makeDevice(storage, "dev-a");
    a.vault.setFile(SECRET_PATH, SECRET);
    a.vault.setFile("Daily/2026-07-16.md", "another private note");
    await a.engine.push();

    const b = await makeDevice(storage, "dev-b");
    await b.engine.pull();
    expect(b.vault.getText(SECRET_PATH)).toBe(SECRET);
    expect(b.vault.getText("Daily/2026-07-16.md")).toBe("another private note");

    // STORAGE SEES ONLY CIPHERTEXT (invariant #3).
    const decoder = new TextDecoder();
    for (const key of storage.keys()) {
      const bytes = await storage.get(key);
      const text = decoder.decode(bytes);
      if (key === KEYFILE_KEY) {
        expect(text).toContain("argon2id"); // non-secret params, by design
        continue;
      }
      // Every stored object is a Syncrypt blob…
      expect(decoder.decode(bytes.subarray(0, 4)), key).toBe("SYNC");
      // …and reveals neither contents nor vault structure.
      expect(text, key).not.toContain("TOP-SECRET");
      expect(text, key).not.toContain("private note");
      expect(text, key).not.toContain("secret-plan");
      expect(text, key).not.toContain("Projects");
      // Object keys must not embed the plaintext content hash either.
      expect(key).not.toMatch(/objects\/.*(af1349|9f2c)/);
    }
  });

  it("a brand-new device joins with ONLY the passphrase (keyfile-params from storage)", async () => {
    const storage = new MemoryStorage();
    const a = await makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "hello from A");
    await a.engine.push();

    // Device C: no shared config beyond the storage handle and the passphrase.
    const c = await makeDevice(storage, "dev-c");
    const report = await c.engine.pull();
    expect(report.outcome).toBe("applied");
    expect(c.vault.getText("note.md")).toBe("hello from A");
  });

  it("a wrong passphrase fails closed on pull — nothing is applied", async () => {
    const storage = new MemoryStorage();
    const a = await makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "sensitive");
    await a.engine.push();

    const intruder = await makeDevice(storage, "dev-x", "wrong passphrase");
    await expect(intruder.engine.pull()).rejects.toSatisfy((e) =>
      isSyncError(e, "CryptoAuthError"),
    );
    expect(intruder.vault.paths()).toEqual([]); // nothing written
  });

  it("a tampered stored object fails closed and is never applied", async () => {
    const storage = new MemoryStorage();
    const a = await makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "authentic content");
    await a.engine.push();

    const objectKey = storage.keys().find((k) => k.startsWith("objects/"));
    expect(objectKey).toBeDefined();
    if (objectKey === undefined) return;
    const blob = await storage.get(objectKey);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff; // corrupt the tag
    await storage.put(objectKey, blob);

    const b = await makeDevice(storage, "dev-b");
    await expect(b.engine.pull()).rejects.toSatisfy((e) =>
      isSyncError(e, "CryptoAuthError"),
    );
    expect(b.vault.getText("note.md")).toBeNull();
  });

  it("conflicts, deletions, and convergence behave exactly as in M1 (fuzz)", async () => {
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
      fc.asyncProperty(fc.array(actionArb, { minLength: 4, maxLength: 12 }), async (actions) => {
        const storage = new MemoryStorage();
        const devices = [
          await makeDevice(storage, "dev-a"),
          await makeDevice(storage, "dev-b"),
        ];
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
            d.vault.setFile(action.path, action.tag < 2 ? `v${action.tag}` : `v${++counter}`);
          } else if (action.type === "delete") {
            await d.vault.delete(action.path);
          } else {
            await syncConfirming(d);
          }
        }
        let converged = false;
        for (let round = 0; round < 12 && !converged; round++) {
          const outcomes: string[] = [];
          for (const d of devices) {
            d.clock.advance(30);
            d.vault.now = d.clock.now();
            outcomes.push(await syncConfirming(d));
          }
          converged = outcomes.every((o) => o === "no-op");
        }
        expect(converged).toBe(true);
        const [a, b] = devices;
        if (a === undefined || b === undefined) return;
        expect(a.vault.paths()).toEqual(b.vault.paths());
        for (const p of a.vault.paths()) expect(a.vault.getText(p)).toBe(b.vault.getText(p));
        // And still: nothing stored in the clear.
        for (const key of storage.keys()) {
          if (key === KEYFILE_KEY) continue;
          const head = new TextDecoder().decode((await storage.get(key)).subarray(0, 4));
          expect(head, key).toBe("SYNC");
        }
      }),
      { numRuns: 25 },
    );
  }, 120_000);
});
