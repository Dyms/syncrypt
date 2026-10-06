// Review 6: the review-3 fuzz plus straddled publishes (ADR-0085): another
// device publishes N and N+1 (with a third pulling in between) while d's PUT
// of N is in flight; and rollback followed by acceptance on one device.
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
  onManifestPut: (() => Promise<void>) | null;
  restart: () => void;
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
  | { t: "release"; d: number }
  | { t: "race"; d: number; e: number; k: number; p: number }
  | { t: "rollback"; d: number; n: number }
  | { t: "reclaim"; d: number }
  | { t: "restart"; d: number }
  | { t: "straddle"; d: number; e: number; f: number; p: number; k: number };

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
  { weight: Number(process.env.RACE_W ?? 2), arbitrary: fc.record({ t: fc.constant("race" as const), d: dA, e: dA, k: fc.integer({ min: 0, max: 3 }), p: pA }) },
  { weight: Number(process.env.RB_W ?? 1), arbitrary: fc.record({ t: fc.constant("rollback" as const), d: dA, n: fc.integer({ min: 1, max: 3 }) }) },
  { weight: Number(process.env.RC_W ?? 1), arbitrary: fc.record({ t: fc.constant("reclaim" as const), d: dA }) },
  { weight: Number(process.env.RS_W ?? 1), arbitrary: fc.record({ t: fc.constant("restart" as const), d: dA }) },
  { weight: Number(process.env.ST_W ?? 3), arbitrary: fc.record({ t: fc.constant("straddle" as const), d: dA, e: dA, f: dA, p: pA, k: fc.integer({ min: 0, max: 2 }) }) },
);

export async function runScenario(actions: Action[], verbose = false): Promise<string[]> {
  const shared = new MemoryStorage();
  let counter = 0;
  const parent = new Map<string, string | null>();
  const userDeleted = new Set<string>();
  const log: string[] = [];
  const offLine: string[] = [];

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
    const dev: Dev = { id, engine: null as unknown as SyncEngine, vault, clock, onGet: null, onManifestPut: null, restart: () => undefined };
    const storage = new Proxy(shared, {
      get(target, key, receiver) {
        if (key === "put") {
          return async (k: string, data: Uint8Array, o?: unknown) => {
            if (k.startsWith("manifests/") && dev.onManifestPut !== null) {
              const f = dev.onManifestPut;
              dev.onManifestPut = null;
              await f();
            }
            return target.put(k, data, o as never);
          };
        }
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
    const stateStore = new MemoryStateStore();
    dev.restart = () => {
      dev.engine = createSyncEngine({
        storage,
        vault,
        crypto: new IdentityCrypto(),
        clock,
        log: (() => {
          const l = new MemoryLog();
          const orig = l.notice.bind(l);
          l.notice = (n) => {
            if (n.code === "base-off-line" || n.code === "fork-lost") offLine.push(`${id} ${n.code} ${JSON.stringify(n)}`);
            orig(n);
          };
          return l;
        })(),
        state: stateStore,
        deviceId: id,
        storagePrefix: "",
        safeSync: {
          ...(id === "dev-b" && process.env.CONFIRM === "1"
            ? { bulkChangeFloor: 0, bulkChangeMaxFiles: 1, bulkChangeMaxFraction: 1 }
            : {}),
          ...((id === "dev-a" && process.env.GRACE === "1") || process.env.GRACE_ALL === "1"
            ? { tombstoneGraceSeconds: 100 }
            : {}),
          generationsToKeep: Number(process.env.KEEP ?? 2),
          reclaimGraceSeconds: Number(process.env.RGRACE ?? 0),
        },
      });
    };
    dev.restart();
    return dev;
  });
  at(devs, 2).vault.excluded = "c.md";

  const syncConfirming = async (d: Dev): Promise<string> => {
    let r = await d.engine.sync();
    if (r.outcome === "rolled-back" && process.env.NOACCEPT !== "1") {
      await d.engine.acceptRolledBack();
      r = await d.engine.sync();
    }
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
        case "race": {
          const e = at(devs, a.e);
          if (e === d) break;
          // e runs to completion while d's manifest PUT is in flight: e's
          // re-list cannot see d's manifest, d's can see e's.
          d.onManifestPut = async () => {
            e.clock.advance(5);
            e.vault.now = e.clock.now();
            try {
              const out = a.k === 3 ? JSON.stringify(await e.engine.forgetPaths([path])) : await syncConfirming(e);
              log.push(`  ${e.id} (inside ${d.id}'s publish) ${a.k === 3 ? "forget " + path : "sync"} -> ${out}`);
            } catch (err) {
              log.push(`  ${e.id} (inside) threw ${String(err)}`);
            }
          };
          let out: string;
          if (a.k === 0 || a.k === 3) out = await syncConfirming(d);
          else if (a.k === 1) out = JSON.stringify(await d.engine.forgetPaths([path]));
          else out = JSON.stringify(await d.engine.releaseForgotten());
          d.onManifestPut = null;
          log.push(`${d.id} race(k=${a.k}) vs ${e.id} -> ${out}`);
          break;
        }
        case "rollback": {
          const keys = shared.keys().filter((k) => k.startsWith("manifests/"));
          const gens = [...new Set(keys.map((k) => Number(k.slice(10, 19))))].sort((x, y) => y - x);
          const drop = new Set(gens.slice(0, Math.min(a.n, gens.length - 1)));
          for (const k of keys) if (drop.has(Number(k.slice(10, 19)))) await shared.delete(k);
          log.push(`storage rolled back: removed generations ${[...drop].join(",")}`);
          break;
        }
        case "straddle": {
          const e = at(devs, a.e);
          const f = at(devs, a.f);
          if (e === d) break;
          // k=0: e publishes N, f pulls it, e publishes N+1 — all inside d's PUT.
          // k=1: e publishes N, then starts a push whose PUT is held until
          //      after d's PUT and re-list (the R5-1 shape).
          // k=2: as k=0 but d's operation is a forget.
          let held: Promise<unknown> = Promise.resolve();
          let openHeld: () => void = () => undefined;
          d.onManifestPut = async () => {
            try {
              const q = at(PATHS, (a.p + 1) % PATHS.length);
              if (q !== e.vault.excluded) userWrite(e, q);
              log.push(`  ${e.id} (inside ${d.id}) sync -> ${await syncConfirming(e)}`);
              if (f !== d && f !== e) log.push(`  ${f.id} (inside ${d.id}) sync -> ${await syncConfirming(f)}`);
              if (path !== e.vault.excluded) userWrite(e, path);
              if (a.k === 1) {
                let reached!: () => void;
                const r = new Promise<void>((res) => (reached = res));
                const gate = new Promise<void>((res) => (openHeld = res));
                e.onManifestPut = async () => {
                  reached();
                  await gate;
                };
                held = e.engine.push().then((x) => log.push(`  ${e.id} held push -> ${x.outcome}`));
                await Promise.race([r, held]);
              } else {
                log.push(`  ${e.id} (inside ${d.id}) sync2 -> ${await syncConfirming(e)}`);
              }
            } catch (err) {
              log.push(`  inside threw ${String(err)}`);
            }
          };
          let out: string;
          try {
            if (a.k === 2) out = JSON.stringify(await d.engine.forgetPaths([path]));
            else out = await syncConfirming(d);
          } finally {
            d.onManifestPut = null;
            openHeld();
            await held.catch(() => undefined);
            e.onManifestPut = null;
          }
          log.push(`${d.id} straddle(k=${a.k}) vs ${e.id}/${f.id} -> ${out}`);
          break;
        }
        case "restart":
          d.restart();
          log.push(`${d.id} restarts`);
          break;
        case "reclaim": {
          const r = await d.engine.reclaimStorage();
          log.push(`${d.id} reclaim -> deleted ${r.deleted.length}, pruned ${r.prunedManifests}`);
          break;
        }
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
    d.onManifestPut = null;
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

  if (process.env.NO_OFFLINE === "1" && offLine.length > 0) {
    if (verbose) console.log(log.join("\n"));
    return offLine;
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

describe.skipIf(process.env.REVIEW6_FUZZ !== "1")("review6 fuzz", () => {
  it("no version is lost", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(actionArb, { minLength: 5, maxLength: Number(process.env.MAXLEN ?? 30) }), async (actions) => {
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
