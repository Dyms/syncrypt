// Review 2 of ADR-0080: a causal "no lost version" fuzz with faults.
// Every user write is a unique version; a version is LOST if at quiescence it
// is in no vault (any path, conflict copies included), in no trash, was not
// deleted by the user, and is not an ancestor of a version that survived or
// that the user deleted.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createSyncEngine, SyncError, type SyncEngine, type VaultPath } from "../../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../../src/testing/index.js";

const PATHS = ["a.md", "b.md", "c.md"] as const;

function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`no element ${String(i)}`);
  return x;
}

class FaultVault extends MemoryVault {
  readLocked = new Set<VaultPath>();
  trashLocked = new Set<VaultPath>();
  afterWrite: ((path: VaultPath) => void) | null = null;
  excluded: string | null = null;
  override async *list(): AsyncIterable<VaultPath> {
    for await (const p of super.list()) if (p !== this.excluded) yield p;
  }
  syncable(path: VaultPath): boolean {
    return path !== this.excluded;
  }
  // Returns what MemoryVault vouches for — the stat of the write itself. An
  // edit by the hook below comes after, with a later mtime (ADR-0082).
  override async write(path: VaultPath, data: Uint8Array): ReturnType<MemoryVault["write"]> {
    const written = await super.write(path, data);
    const f = this.afterWrite;
    if (f !== null) {
      this.afterWrite = null;
      f(path);
    }
    return written;
  }
  override read(path: VaultPath): Promise<Uint8Array> {
    if (this.readLocked.has(path)) return Promise.reject(new SyncError("VaultWriteFailed", "locked"));
    return super.read(path);
  }
  override async trash(path: VaultPath): Promise<void> {
    if (this.trashLocked.has(path)) throw new SyncError("VaultWriteFailed", "locked");
    return super.trash(path);
  }
}

interface Dev {
  id: string;
  engine: SyncEngine;
  vault: FaultVault;
  clock: FixedClock;
  onGet: (() => void) | null;
}

export type Action =
  | { t: "write"; d: number; p: number }
  | { t: "delete"; d: number; p: number }
  | { t: "sync"; d: number }
  | { t: "push"; d: number }
  | { t: "pull"; d: number }
  | { t: "lockRead"; d: number; p: number }
  | { t: "lockTrash"; d: number; p: number }
  | { t: "unlock"; d: number }
  | { t: "editDuringDownload"; d: number; p: number }
  | { t: "forget"; d: number; p: number }
  | { t: "editAfterWrite"; d: number }
  | { t: "forgetUncarried"; d: number }
  | { t: "release"; d: number };

const dA = fc.integer({ min: 0, max: 2 });
const pA = fc.integer({ min: 0, max: PATHS.length - 1 });
export const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: Number(process.env.FU_W ?? 1), arbitrary: fc.record({ t: fc.constant("forgetUncarried" as const), d: dA }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("release" as const), d: dA }) },
  { weight: Number(process.env.EAW_W ?? 1), arbitrary: fc.record({ t: fc.constant("editAfterWrite" as const), d: dA }) },
  { weight: 6, arbitrary: fc.record({ t: fc.constant("write" as const), d: dA, p: pA }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("delete" as const), d: dA, p: pA }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("sync" as const), d: dA }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("push" as const), d: dA }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("pull" as const), d: dA }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("lockRead" as const), d: dA, p: pA }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("lockTrash" as const), d: dA, p: pA }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("unlock" as const), d: dA }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("editDuringDownload" as const), d: dA, p: pA }) },
  { weight: Number(process.env.FORGET_W ?? 1), arbitrary: fc.record({ t: fc.constant("forget" as const), d: dA, p: pA }) },
);

export async function runScenario(actions: Action[], verbose = false): Promise<string[]> {
  const shared = new MemoryStorage();
  let counter = 0;
  const parent = new Map<string, string | null>();
  const userDeleted = new Set<string>();
  const log: string[] = [];

  const userWrite = (dev: Dev, path: string): void => {
    const present = dev.vault.getText(path);
    const id = `v${++counter}-${"x".repeat(counter % 7)}`;
    parent.set(id, present);
    dev.clock.advance(7);
    dev.vault.now = dev.clock.now();
    dev.vault.setFile(path, id);
    log.push(`${dev.id} writes ${path}=${id} (parent ${String(present)})`);
  };

  const devs: Dev[] = ["dev-a", "dev-b", "dev-c"].map((id) => {
    const vault = new FaultVault();
    const clock = new FixedClock();
    const dev: Dev = { id, engine: null as unknown as SyncEngine, vault, clock, onGet: null };
    const storage = new Proxy(shared, {
      get(target, key, receiver) {
        if (key === "get") {
          return async (k: string) => {
            if (k.startsWith("objects/") && dev.onGet !== null) {
              const f = dev.onGet;
              dev.onGet = null;
              f();
            }
            return target.get(k);
          };
        }
        const v = Reflect.get(target, key, receiver) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    dev.engine = createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock,
      log: new MemoryLog(),
      state: new MemoryStateStore(),
      deviceId: id,
      storagePrefix: "",
      ...(id === "dev-b" && process.env.CONFIRM === "1"
        ? { safeSync: { bulkChangeFloor: 0, bulkChangeMaxFiles: 1, bulkChangeMaxFraction: 1 } }
        : {}),
      ...(id === "dev-a" && process.env.GRACE === "1" ? { safeSync: { tombstoneGraceSeconds: 100 } } : {}),
    });
    return dev;
  });
  at(devs, 2).vault.excluded = "c.md";

  const syncConfirming = async (d: Dev): Promise<string> => {
    const r = await d.engine.sync();
    if (r.outcome === "needs-confirmation") {
      const plan = await d.engine.dryRun();
      return (await d.engine.confirmAndApply(plan)).outcome;
    }
    return r.outcome;
  };

  for (const a of actions) {
    const d = at(devs, a.d);
    d.clock.advance(30);
    d.vault.now = d.clock.now();
    const path = "p" in a ? at(PATHS, a.p) : "";
    try {
      switch (a.t) {
        case "write":
          if (path === d.vault.excluded) break;
          userWrite(d, path);
          break;
        case "delete": {
          const present = d.vault.getText(path);
          if (present !== null) {
            userDeleted.add(present);
            await d.vault.delete(path);
            log.push(`${d.id} deletes ${path} (${present})`);
          }
          break;
        }
        case "sync":
          log.push(`${d.id} sync -> ${await syncConfirming(d)}`);
          break;
        case "push":
          log.push(`${d.id} push -> ${(await d.engine.push()).outcome}`);
          break;
        case "pull":
          log.push(`${d.id} pull -> ${(await d.engine.pull()).outcome}`);
          break;
        case "lockRead":
          d.vault.readLocked.add(path);
          log.push(`${d.id} lockRead ${path}`);
          break;
        case "lockTrash":
          d.vault.trashLocked.add(path);
          log.push(`${d.id} lockTrash ${path}`);
          break;
        case "unlock":
          d.vault.readLocked.clear();
          d.vault.trashLocked.clear();
          log.push(`${d.id} unlock`);
          break;
        case "editDuringDownload":
          d.onGet = () => {
            if (d.vault.getText(path) !== null) userWrite(d, path);
          };
          log.push(`${d.id} arms edit-during-download ${path}`);
          break;
        case "editAfterWrite":
          d.vault.afterWrite = (wp) => {
            if (PATHS.includes(wp as (typeof PATHS)[number])) userWrite(d, wp);
          };
          log.push(`${d.id} arms edit-after-engine-write`);
          break;
        case "forgetUncarried": {
          const u = await d.engine.listUncarried();
          log.push(`${d.id} forgetUncarried -> ${JSON.stringify(await d.engine.forgetPaths(u.map((x) => x.path)))}`);
          break;
        }
        case "release":
          log.push(`${d.id} release -> ${JSON.stringify(await d.engine.releaseForgotten())}`);
          break;
        case "forget":
          log.push(`${d.id} forget ${path} -> ${JSON.stringify(await d.engine.forgetPaths([path]))}`);
          break;
      }
    } catch (e) {
      log.push(`${d.id} ${a.t} threw ${String(e)}`);
    }
  }

  for (const d of devs) {
    d.vault.readLocked.clear();
    d.vault.trashLocked.clear();
    d.onGet = null;
    d.vault.afterWrite = null;
  }
  for (let round = 0; round < 8; round++) {
    for (const d of devs) {
      d.clock.advance(30);
      d.vault.now = d.clock.now();
      try {
        log.push(`${d.id} final sync -> ${await syncConfirming(d)}`);
      } catch (e) {
        log.push(`${d.id} final sync threw ${String(e)}`);
      }
    }
  }

  const conv: string[] = [];
  for (const d of devs) {
    const st = await d.engine.status();
    if (st.dirtyFiles !== 0) conv.push(`${d.id} dirty ${st.dirtyFiles}`);
  }
  const a0 = at(devs, 0).vault.paths().map((p) => `${p}=${at(devs, 0).vault.getText(p)}`).join(",");
  const a1 = at(devs, 1).vault.paths().map((p) => `${p}=${at(devs, 1).vault.getText(p)}`).join(",");
  if (a0 !== a1) conv.push(`diverged ${a0} | ${a1}`);
  if (process.env.CONV === "1" && conv.length > 0) {
    if (verbose) console.log(log.join("\n"));
    return conv;
  }
  const surviving = new Set<string>();
  for (const d of devs) {
    for (const p of d.vault.paths()) surviving.add(d.vault.getText(p) ?? "");
    for (const t of d.vault.trashed) surviving.add(new TextDecoder().decode(t.data));
  }
  const covered = new Set<string>();
  for (const s of [...surviving, ...userDeleted]) {
    let cur: string | null | undefined = s;
    while (cur !== null && cur !== undefined && !covered.has(cur)) {
      covered.add(cur);
      cur = parent.get(cur);
    }
  }
  const lost = [...parent.keys()].filter((v) => !covered.has(v));
  if (lost.length > 0 && verbose) {
    console.log(log.join("\n"));
    for (const d of devs) console.log(d.id, d.vault.paths().map((p) => `${p}=${d.vault.getText(p)}`));
  }
  return lost;
}

describe.skipIf(process.env.REVIEW_FUZZ !== "1")("review2 fuzz", () => {
  it("no version is lost", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { minLength: 5, maxLength: 30 }), async (actions) => {
        const lost = await runScenario(actions);
        expect(lost, JSON.stringify(actions)).toEqual([]);
      }),
      {
        numRuns: Number(process.env.RUNS ?? 300),
        ...(process.env.SEED !== undefined ? { seed: Number(process.env.SEED) } : {}),
      },
    );
  }, 600_000);
});
