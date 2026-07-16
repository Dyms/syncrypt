// M1 EXIT CRITERION: two real local directories ("devices") sharing one local
// storage directory converge over fuzzed edit/delete/sync sequences with zero
// content loss and zero silent overwrite. Storage runs in BOTH capability
// modes so the universal LIST protocol (ADR-0006) is exercised end to end.

import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";

import { createSyncEngine, type SyncEngine } from "@syncrypt/core";
import {
  FixedClock,
  IdentityCrypto,
  MemoryStateStore,
} from "@syncrypt/core/testing";

import { FilesystemStorage, FilesystemVault } from "../src/index.js";

const PATHS = ["a.md", "b.md", "dir/c.md", "d.md"] as const;

interface Device {
  engine: SyncEngine;
  vault: FilesystemVault;
  root: string;
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

const cleanups: string[] = [];
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

async function makeWorld(conditionalWrites: boolean): Promise<{
  storage: FilesystemStorage;
  storageRoot: string;
  devices: Device[];
}> {
  const base = await mkdtemp(path.join(tmpdir(), "syncrypt-e2e-"));
  cleanups.push(base);
  const storageRoot = path.join(base, "storage");
  const storage = new FilesystemStorage(storageRoot, { conditionalWrites });
  const devices: Device[] = [];
  for (const id of ["dev-a", "dev-b"]) {
    const root = path.join(base, id);
    await mkdir(root, { recursive: true });
    const vault = new FilesystemVault(root);
    const clock = new FixedClock();
    devices.push({
      engine: createSyncEngine({
        storage,
        vault,
        crypto: new IdentityCrypto(),
        clock,
        state: new MemoryStateStore(),
        deviceId: id,
        storagePrefix: "",
      }),
      vault,
      root,
      clock,
    });
  }
  return { storage, storageRoot, devices };
}

/** All regular files under a device root (canonical paths), EXCLUDING trash. */
async function vaultSnapshot(d: Device): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const p of d.vault.list()) {
    out.set(p, new TextDecoder().decode(await d.vault.read(p)));
  }
  return out;
}

/** Every byte-string recoverable on this device or from storage. */
async function recoverable(d: Device, storageRoot: string): Promise<Set<string>> {
  const set = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else set.add(new TextDecoder().decode(await readFile(full)));
    }
  };
  await walk(d.root); // vault files + conflicted copies + .obsidian/sync-trash
  await walk(path.join(storageRoot, "objects")); // identity crypto ⇒ plaintext
  return set;
}

async function syncConfirming(d: Device, storageRoot: string): Promise<string> {
  const before = await vaultSnapshot(d);
  let report = await d.engine.sync();
  if (report.outcome === "needs-confirmation") {
    const plan = await d.engine.dryRun();
    report = await d.engine.confirmAndApply(plan);
  }
  // NO DATA LOSS: everything that was in the vault before the engine acted is
  // still reachable (vault, conflicted copy, trash, or storage object).
  const reachable = await recoverable(d, storageRoot);
  for (const [p, content] of before) {
    expect(reachable.has(content), `content of "${p}" lost by sync`).toBe(true);
  }
  return report.outcome;
}

function runFuzz(conditionalWrites: boolean) {
  return async () => {
    let writeCounter = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(actionArb, { minLength: 4, maxLength: 14 }),
        async (actions) => {
          const { storageRoot, devices } = await makeWorld(conditionalWrites);
          for (const action of actions) {
            const d = devices[action.device];
            if (d === undefined) continue;
            d.clock.advance(60);
            switch (action.type) {
              case "write": {
                const content =
                  action.tag < 3 ? `v${action.tag}` : `v${action.tag}-${++writeCounter}`;
                const native = path.join(d.root, ...action.path.split("/"));
                await mkdir(path.dirname(native), { recursive: true });
                await writeFile(native, content); // the USER edits directly
                break;
              }
              case "delete":
                await rm(path.join(d.root, ...action.path.split("/")), { force: true });
                break;
              case "sync":
                await syncConfirming(d, storageRoot);
                break;
            }
          }

          // Quiescence → convergence.
          let converged = false;
          for (let round = 0; round < 12 && !converged; round++) {
            const outcomes: string[] = [];
            for (const d of devices) {
              d.clock.advance(60);
              outcomes.push(await syncConfirming(d, storageRoot));
            }
            converged = outcomes.every((o) => o === "no-op");
          }
          expect(converged, "devices did not reach a no-op fixpoint").toBe(true);

          const [a, b] = devices;
          if (a === undefined || b === undefined) return;
          const snapA = await vaultSnapshot(a);
          const snapB = await vaultSnapshot(b);
          expect([...snapA.keys()].sort()).toEqual([...snapB.keys()].sort());
          for (const [p, content] of snapA) {
            expect(snapB.get(p), `divergent content at ${p}`).toBe(content);
          }
        },
      ),
      { numRuns: 20 },
    );
  };
}

describe("two real directories converge over fuzzed runs (M1 exit)", () => {
  it("with conditional writes", runFuzz(true), 300_000);
  it("universal subset only (no conditional writes)", runFuzz(false), 300_000);
});
