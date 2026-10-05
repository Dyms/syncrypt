// ADR-0060. `safeSync` in the SDK was re-declared inline as
// `Partial<PlanOptions> & { versionsToKeep?: number }` and then stopped being
// updated: ADR-0030 and ADR-0031 added three settings to the engine and none
// of them to the SDK's copy. The plugin passes a variable, so TypeScript's
// excess-property check never fired and nobody noticed — an SDK caller writing
// the literal did not compile against settings the engine has honoured since.
//
// A type cannot be held by a test that RUNS. It is held by one that COMPILES:
// narrow the type again and `npm run typecheck` fails on this file. The
// assertions below exist so the literal is also exercised end to end, and so
// the values the engine ends up using are the ones that were passed.

import { describe, expect, it } from "vitest";

import type { SafeSyncOptions } from "@syncrypt/core";
import { FixedClock, MemoryStateStore, MemoryStorage, MemoryVault } from "@syncrypt/core/testing";

import { openSyncEngine, type OpenSyncEngineOptions } from "../src/index.js";

/** Every knob, as a LITERAL — which is the only way the check fires. */
const EVERY_KNOB = {
  // ADR-0010 / RFC-0004 plan options
  bulkChangeFloor: 10,
  bulkChangeMaxFiles: 500,
  bulkChangeMaxFraction: 0.3,
  deletionBurstWindow: 3600,
  // the four the engine grew and the SDK's copy did not
  versionsToKeep: 5,
  tombstoneGraceSeconds: 14 * 24 * 60 * 60,
  reclaimGraceSeconds: 2 * 24 * 60 * 60,
  generationsToKeep: 7,
} satisfies SafeSyncOptions;

describe("the SDK accepts every setting the engine honours", () => {
  it("THE LITERAL COMPILES — WHICH IS THE WHOLE TEST", () => {
    // A type cannot be held by a test that runs: narrow `SafeSyncOptions`
    // again and `npm run typecheck` fails on the annotation below. The
    // assertions that used to be here only read back this file's own const
    // (ADR-0061), so they are gone.
    const opts: NonNullable<OpenSyncEngineOptions["safeSync"]> = EVERY_KNOB;
    expect(Object.keys(opts).sort()).toEqual([
      "bulkChangeFloor",
      "bulkChangeMaxFiles",
      "bulkChangeMaxFraction",
      "deletionBurstWindow",
      "generationsToKeep",
      "reclaimGraceSeconds",
      "tombstoneGraceSeconds",
      "versionsToKeep",
    ]);
  });

  it("AND THE ENGINE IS ACTUALLY OPENED WITH THEM", async () => {
    // The previous version of this test asserted `sweep === []` and
    // `prunedManifests === []` on a freshly synced one-file vault — true for
    // every value of every setting, so deleting the `safeSync` pass-through
    // from the SDK left it green (ADR-0061).
    //
    // `reclaimGraceSeconds` is the cheapest setting with a visible effect: a
    // short grace sweeps on a clock the DEFAULT grace (one day) would not.
    const GRACE = 100;
    const storage = new MemoryStorage();
    const vault = new MemoryVault();
    const clock = new FixedClock(1_000_000);
    const engine = await openSyncEngine({
      storage,
      vault,
      passphrase: "p",
      deviceId: "dev-a",
      state: new MemoryStateStore(),
      clock,
      kdfDefaults: {
        kdf: "argon2id",
        version: 1,
        memoryKiB: 19456,
        iterations: 2,
        parallelism: 1,
      },
      safeSync: {
        ...EVERY_KNOB,
        reclaimGraceSeconds: GRACE,
        // Nothing may hold a reference to the old object: no retained prior
        // version, and no retained older manifest generation.
        versionsToKeep: 0,
        generationsToKeep: 1,
      },
    });

    // One object becomes garbage: the file is rewritten, so the first
    // ciphertext is referenced by nothing retained.
    vault.setFile("note.md", "first version");
    await engine.sync();
    vault.now += 10;
    clock.advance(10);
    vault.setFile("note.md", "second version, of another length");
    await engine.sync();
    const objects = () => storage.keys().filter((k) => k.startsWith("objects/"));
    expect(objects()).toHaveLength(2);

    await engine.reclaimStorage(); // marks it
    clock.advance(GRACE + 1); // past OUR grace, far short of the default day
    const swept = await engine.reclaimStorage();

    expect(swept.deleted).toHaveLength(1);
    expect(objects()).toHaveLength(1);
  });
});
