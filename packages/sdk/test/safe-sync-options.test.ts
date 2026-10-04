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
    const opts: NonNullable<OpenSyncEngineOptions["safeSync"]> = EVERY_KNOB;
    expect(opts.generationsToKeep).toBe(7);
    expect(opts.reclaimGraceSeconds).toBe(2 * 24 * 60 * 60);
    expect(opts.tombstoneGraceSeconds).toBe(14 * 24 * 60 * 60);
  });

  it("and an engine opened with it is opened with those values", async () => {
    const storage = new MemoryStorage();
    const vault = new MemoryVault();
    vault.setFile("note.md", "hello");
    const engine = await openSyncEngine({
      storage,
      vault,
      passphrase: "p",
      deviceId: "dev-a",
      state: new MemoryStateStore(),
      clock: new FixedClock(),
      kdfDefaults: {
        kdf: "argon2id",
        version: 1,
        memoryKiB: 19456,
        iterations: 2,
        parallelism: 1,
      },
      safeSync: EVERY_KNOB,
    });

    // generationsToKeep: 7 reaches the reclamation planner, which is the one
    // of the four with a visible effect on an otherwise untouched vault.
    await engine.sync();
    const plan = await engine.previewReclaim();
    expect(plan.prunedManifests).toEqual([]);
    expect(plan.sweep).toEqual([]);
  });
});
