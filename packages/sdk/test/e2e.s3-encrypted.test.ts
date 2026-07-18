// M3 EXIT: the SDK wires a real encrypted sync over a LIVE S3 bucket — two
// devices converge across a fuzzed run, and the bucket holds only ciphertext.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { type SyncEngine } from "@syncrypt/core";
import { FixedClock, MemoryStateStore, MemoryVault } from "@syncrypt/core/testing";
import { KEYFILE_KEY } from "@syncrypt/crypto";
import { S3Storage, type S3Config } from "@syncrypt/provider-s3";
import { createBucket, deleteBucketRecursive } from "@syncrypt/provider-s3/testing";

import { openSyncEngine } from "../src/index.js";

const endpoint = process.env.SYNCRYPT_S3_TEST_ENDPOINT;
const PASSPHRASE = "sdk e2e passphrase";
const KDF_TEST_PRESET = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 19456, // ADR-0014 floor — fast but valid
  iterations: 2,
  parallelism: 1,
} as const;

if (endpoint === undefined || endpoint === "") {
  console.warn(
    "⚠ sdk e2e SKIPPED — no live S3 backend. Set SYNCRYPT_S3_TEST_ENDPOINT (local MinIO) to run it.",
  );
  describe.skip("sdk e2e over S3 (no live backend)", () => {
    it.skip("requires SYNCRYPT_S3_TEST_ENDPOINT", () => undefined);
  });
} else {
  const baseConfig = (): S3Config => ({
    endpoint,
    bucket: `syncrypt-sdk-${[...crypto.getRandomValues(new Uint8Array(6))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`,
    accessKeyId: process.env.SYNCRYPT_S3_TEST_ACCESS_KEY ?? "minioadmin",
    secretAccessKey: process.env.SYNCRYPT_S3_TEST_SECRET_KEY ?? "minioadmin",
    forcePathStyle: true,
    retry: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 500 },
  });

  interface Device {
    engine: SyncEngine;
    vault: MemoryVault;
    clock: FixedClock;
  }

  describe("sdk: encrypted two-device sync over live S3", () => {
    it("converges across a fuzzed run; the bucket holds ONLY ciphertext", async () => {
      const config = baseConfig();
      await createBucket(config);
      const storage = await S3Storage.create(config);
      try {
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
            // Fresh prefix per run isolates runs inside one bucket.
            const prefix = `run-${++counter}`;
            const devices: Device[] = [];
            const vaultA = new MemoryVault();
            const vaultB = new MemoryVault();
            for (const [id, vault] of [["dev-a", vaultA], ["dev-b", vaultB]] as const) {
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

        // CIPHERTEXT-ONLY: every stored object is a SYNC blob or the keyfile.
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
          expect(stat.key).not.toMatch(/\.md/); // no plaintext path in any key
          checked++;
        }
        expect(checked).toBeGreaterThan(0);
      } finally {
        await deleteBucketRecursive(config);
      }
    }, 300_000);
  });
}
