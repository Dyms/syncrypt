// Fuzzed two-device convergence (M1 exit criterion, at the engine level):
// random edit/delete/sync sequences on two devices sharing one storage, then
// assert (1) CONVERGENCE — both vaults byte-identical after quiescent syncs —
// and (2) NO DATA LOSS — no engine action ever makes content unreachable
// (it stays in the vault, in a conflicted copy, in the trash, or in storage).
//
// The driver plays the user: needs-confirmation outcomes are confirmed via
// dryRun + confirmAndApply, exactly like a real client would.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createSyncEngine, type SyncEngine } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

const PATHS = ["a.md", "b.md", "dir/c.md", "d.md"] as const;

interface Device {
  engine: SyncEngine;
  vault: MemoryVault;
  clock: FixedClock;
}

type Action =
  | { type: "write"; device: number; path: string; tag: number }
  | { type: "delete"; device: number; path: string }
  | { type: "sync"; device: number };

const deviceArb = fc.integer({ min: 0, max: 1 });
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      type: fc.constant("write" as const),
      device: deviceArb,
      path: fc.constantFrom(...PATHS),
      tag: fc.integer({ min: 0, max: 4 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("delete" as const),
      device: deviceArb,
      path: fc.constantFrom(...PATHS),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ type: fc.constant("sync" as const), device: deviceArb }),
  },
);

function makeDevice(storage: MemoryStorage, id: string): Device {
  const vault = new MemoryVault();
  const clock = new FixedClock();
  const engine = createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock,
    state: new MemoryStateStore(),
    deviceId: id,
    storagePrefix: "",
  });
  return { engine, vault, clock };
}

async function storageContents(storage: MemoryStorage): Promise<Set<string>> {
  const contents = new Set<string>();
  for (const key of storage.keys()) {
    if (!key.startsWith("objects/")) continue;
    contents.add(new TextDecoder().decode(await storage.get(key)));
  }
  return contents;
}

/** Run one engine action; assert it lost none of the device's prior content. */
async function checkedStep(
  storage: MemoryStorage,
  d: Device,
  fn: () => Promise<unknown>,
): Promise<void> {
  const before = new Map(d.vault.paths().map((p) => [p, d.vault.getText(p)]));
  await fn();
  const inVault = new Set(d.vault.paths().map((p) => d.vault.getText(p)));
  const inTrash = new Set(
    d.vault.trashed.map((t) => new TextDecoder().decode(t.data)),
  );
  const inStorage = await storageContents(storage);
  for (const [path, content] of before) {
    if (content === null) continue;
    const reachable =
      inVault.has(content) || inTrash.has(content) || inStorage.has(content);
    expect(
      reachable,
      `content of "${path}" became unreachable after an engine action`,
    ).toBe(true);
  }
}

/** sync once, auto-confirming like a user would; returns the final outcome. */
async function syncConfirming(storage: MemoryStorage, d: Device): Promise<string> {
  let outcome = "";
  await checkedStep(storage, d, async () => {
    const report = await d.engine.sync();
    outcome = report.outcome;
    if (report.outcome === "needs-confirmation") {
      const plan = await d.engine.dryRun();
      const confirmed = await d.engine.confirmAndApply(plan);
      outcome = confirmed.outcome;
    }
  });
  return outcome;
}

describe("fuzzed two-device convergence (no loss, no silent overwrite)", () => {
  it("converges with zero content loss over random action sequences", async () => {
    let writeCounter = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(actionArb, { minLength: 5, maxLength: 25 }),
        async (actions) => {
          const storage = new MemoryStorage();
          const devices = [makeDevice(storage, "dev-a"), makeDevice(storage, "dev-b")];

          for (const action of actions) {
            const d = devices[action.device];
            if (d === undefined) continue;
            d.clock.advance(30);
            d.vault.now = d.clock.now();
            switch (action.type) {
              case "write": {
                // A mix of repeated contents (same-change-both-sides) and
                // unique contents (real divergence).
                const content =
                  action.tag < 3 ? `v${action.tag}` : `v${action.tag}-${++writeCounter}`;
                d.vault.setFile(action.path, content);
                break;
              }
              case "delete":
                await d.vault.delete(action.path); // the USER deletes — intentional
                break;
              case "sync":
                await syncConfirming(storage, d);
                break;
            }
          }

          // Quiescence: no more edits; sync both until both report no-op.
          let converged = false;
          for (let round = 0; round < 12 && !converged; round++) {
            const outcomes: string[] = [];
            for (const d of devices) {
              d.clock.advance(30);
              d.vault.now = d.clock.now();
              outcomes.push(await syncConfirming(storage, d));
            }
            converged = outcomes.every((o) => o === "no-op");
          }
          expect(converged, "devices did not reach a no-op fixpoint").toBe(true);

          // CONVERGENCE: identical paths and identical bytes.
          const [a, b] = devices;
          if (a === undefined || b === undefined) return;
          expect(a.vault.paths()).toEqual(b.vault.paths());
          for (const p of a.vault.paths()) {
            expect(a.vault.getText(p), `divergent content at ${p}`).toBe(
              b.vault.getText(p),
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  }, 120_000);
});
