// SyncEngine behavior over in-memory ports — RFC-0007 §7/§8, ADR-0006/0010/0012.

import { describe, expect, it } from "vitest";

import {
  createSyncEngine,
  isSyncError,
  manifestKey,
  serializeManifest,
  type Manifest,
  type SyncEngine,
} from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

interface Device {
  engine: SyncEngine;
  vault: MemoryVault;
  log: MemoryLog;
  state: MemoryStateStore;
  clock: FixedClock;
}

function makeDevice(
  storage: MemoryStorage,
  deviceId: string,
  opts: { prefix?: string; safeSync?: { bulkChangeMaxFiles?: number; bulkChangeMaxFraction?: number; versionsToKeep?: number } } = {},
): Device {
  const vault = new MemoryVault();
  const log = new MemoryLog();
  const state = new MemoryStateStore();
  const clock = new FixedClock();
  const engine = createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock,
    log,
    state,
    deviceId,
    storagePrefix: opts.prefix ?? "",
    ...(opts.safeSync ? { safeSync: opts.safeSync } : {}),
  });
  return { engine, vault, log, state, clock };
}

describe("push / pull round trip", () => {
  it("publishes generation 1 and a second device receives the files", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    const b = makeDevice(storage, "dev-b");

    a.vault.setFile("note.md", "hello");
    a.vault.setFile("dir/deep.md", "world");

    const pushReport = await a.engine.push();
    expect(pushReport.outcome).toBe("applied");
    expect(pushReport.toGeneration).toBe(1);
    expect(pushReport.entries).toHaveLength(2);
    expect(pushReport.entries.every((e) => e.message.length > 0)).toBe(true);

    const pullReport = await b.engine.pull();
    expect(pullReport.outcome).toBe("applied");
    expect(pullReport.toGeneration).toBe(1);
    expect(b.vault.getText("note.md")).toBe("hello");
    expect(b.vault.getText("dir/deep.md")).toBe("world");

    // Idempotence: a second pull/push does nothing.
    expect((await b.engine.pull()).outcome).toBe("no-op");
    expect((await a.engine.push()).outcome).toBe("no-op");
  });

  it("respects the storage prefix", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a", { prefix: "vaults/main" });
    a.vault.setFile("note.md", "hello");
    await a.engine.push();
    expect(storage.keys().every((k) => k.startsWith("vaults/main/"))).toBe(true);
    const b = makeDevice(storage, "dev-b", { prefix: "vaults/main" });
    await b.engine.pull();
    expect(b.vault.getText("note.md")).toBe("hello");
  });

  it("manifest is published LAST: aborting mid-push leaves no new generation", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "hello");

    const controller = new AbortController();
    controller.abort();
    const report = await a.engine.push(controller.signal);
    expect(report.outcome).toBe("aborted");
    expect(storage.keys().filter((k) => k.startsWith("manifests/"))).toEqual([]);
  });
});

describe("divergence guard (ADR-0002 / FR-8)", () => {
  it("push stops with pull-first when another device published", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    const b = makeDevice(storage, "dev-b");

    a.vault.setFile("a.md", "from a");
    await a.engine.push();

    b.vault.setFile("b.md", "from b");
    const report = await b.engine.push();
    expect(report.outcome).toBe("pull-first");
    // Nothing was committed for b.
    expect(storage.keys().filter((k) => k.startsWith("manifests/"))).toHaveLength(1);

    await b.engine.pull();
    const second = await b.engine.push();
    expect(second.outcome).toBe("applied");
    expect(second.toGeneration).toBe(2);
  });
});

// NOTE: several fixtures below raise bulkChangeMaxFraction — with the strict
// ADR-0010 default (10% of the vault), ANY deletion in a vault of <10 files
// trips the breaker, which is not what those tests exercise.
const relaxedBreaker = { safeSync: { bulkChangeMaxFraction: 1 } };

describe("deletions (tombstones + trash, ADR-0010)", () => {
  it("a local deletion tombstones remotely and lands in the other device's trash", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a", relaxedBreaker);
    const b = makeDevice(storage, "dev-b", relaxedBreaker);

    a.vault.setFile("keep.md", "keep");
    a.vault.setFile("gone.md", "precious bytes");
    await a.engine.push();
    await b.engine.pull();

    await a.vault.delete("gone.md"); // the user deletes locally
    const push = await a.engine.push();
    expect(push.outcome).toBe("applied");
    expect(push.entries.map((e) => e.kind)).toContain("delete-remote");

    const pull = await b.engine.pull();
    expect(pull.outcome).toBe("applied");
    expect(b.vault.getText("gone.md")).toBeNull();
    // NEVER hard-deleted: the bytes are in the trash.
    expect(b.vault.trashed.map((t) => t.path)).toEqual(["gone.md"]);
    expect(new TextDecoder().decode(b.vault.trashed[0]?.data ?? new Uint8Array())).toBe(
      "precious bytes",
    );
  });
});

describe("conflicts (ADR-0012)", () => {
  async function conflictSetup(): Promise<{ storage: MemoryStorage; a: Device; b: Device }> {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a", relaxedBreaker);
    const b = makeDevice(storage, "dev-b", relaxedBreaker);
    a.vault.setFile("note.md", "base");
    a.vault.setFile("stable.md", "unchanging");
    await a.engine.push();
    await b.engine.pull();
    return { storage, a, b };
  }

  it("both-changed: keeps local, materializes remote as a conflicted copy, converges", async () => {
    const { a, b } = await conflictSetup();
    a.vault.setFile("note.md", "version A");
    await a.engine.sync();
    b.vault.setFile("note.md", "version B");

    const report = await b.engine.sync();
    expect(report.outcome).toBe("conflicts");
    expect(report.conflicts).toEqual(["note.md"]);
    // Local version untouched at the path; remote version alongside.
    expect(b.vault.getText("note.md")).toBe("version B");
    const copy = b.vault.paths().find((p) => p.includes("conflicted copy from dev-a"));
    expect(copy).toBeDefined();
    expect(b.vault.getText(copy ?? "")).toBe("version A");

    // Convergence: both devices end with both versions, no bytes lost.
    await a.engine.sync();
    expect(a.vault.paths()).toEqual(b.vault.paths());
    for (const p of a.vault.paths()) {
      expect(a.vault.getText(p)).toBe(b.vault.getText(p));
    }
    const texts = a.vault.paths().map((p) => a.vault.getText(p));
    expect(texts).toContain("version A");
    expect(texts).toContain("version B");
  });

  it("edited locally / deleted remotely: the edit survives and is re-uploaded", async () => {
    const { a, b } = await conflictSetup();
    await a.vault.delete("note.md");
    await a.engine.sync();
    b.vault.setFile("note.md", "precious edit");

    const report = await b.engine.sync();
    expect(report.conflicts).toEqual(["note.md"]);
    expect(b.vault.getText("note.md")).toBe("precious edit");

    await a.engine.sync();
    expect(a.vault.getText("note.md")).toBe("precious edit"); // revived on a
  });

  it("deleted locally / edited remotely: the edit is restored locally", async () => {
    const { a, b } = await conflictSetup();
    a.vault.setFile("note.md", "remote edit wins over delete");
    await a.engine.sync();
    await b.vault.delete("note.md");

    const report = await b.engine.sync();
    expect(report.conflicts).toEqual(["note.md"]);
    expect(b.vault.getText("note.md")).toBe("remote edit wins over delete");

    await a.engine.sync();
    await b.engine.sync();
    expect((await a.engine.sync()).outcome).toBe("no-op");
    expect((await b.engine.sync()).outcome).toBe("no-op");
  });
});

describe("Safe-Sync circuit breaker (ADR-0010 §4)", () => {
  it("a bulk remote deletion needs confirmation; confirmAndApply then applies it", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    const b = makeDevice(storage, "dev-b");
    for (let i = 0; i < 30; i++) a.vault.setFile(`f${String(i)}.md`, `content ${String(i)}`);
    await a.engine.push();
    await b.engine.pull();

    // Device A mass-deletes (25 of 30) and pushes.
    for (let i = 0; i < 25; i++) await a.vault.delete(`f${String(i)}.md`);
    const pushPlan = await a.engine.dryRun();
    expect(pushPlan.requiresConfirmation).toBe(true);
    expect((await a.engine.push()).outcome).toBe("needs-confirmation");
    expect((await a.engine.sync()).outcome).toBe("needs-confirmation");

    const confirmed = await a.engine.confirmAndApply(pushPlan);
    expect(confirmed.outcome).toBe("applied");

    // Device B now sees a mass delete-local — its own breaker fires too.
    const pull = await b.engine.pull();
    expect(pull.outcome).toBe("needs-confirmation");
    expect(b.vault.paths()).toHaveLength(30); // nothing applied yet

    const plan = await b.engine.dryRun();
    const applied = await b.engine.confirmAndApply(plan);
    expect(applied.outcome).toBe("applied");
    expect(b.vault.paths()).toHaveLength(5);
    expect(b.vault.trashed).toHaveLength(25); // recoverable, per ADR-0010 §1
  });

  it("confirmAndApply refuses when NEW destructive operations appeared since confirmation", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    const b = makeDevice(storage, "dev-b");
    for (let i = 0; i < 30; i++) a.vault.setFile(`f${String(i)}.md`, `content ${String(i)}`);
    await a.engine.push();
    await b.engine.pull();

    for (let i = 0; i < 25; i++) await a.vault.delete(`f${String(i)}.md`);
    const confirmedPlan = await a.engine.dryRun();
    // The world changes AFTER the user saw the plan: one more file vanishes.
    await a.vault.delete("f25.md");
    const result = await a.engine.confirmAndApply(confirmedPlan);
    expect(result.outcome).toBe("needs-confirmation");
    // Nothing was committed.
    expect(storage.keys().filter((k) => k.startsWith("manifests/"))).toHaveLength(1);
  });
});

describe("fork detection & resolution (ADR-0006)", () => {
  it("readers resolve a fork deterministically: smallest deviceId wins", async () => {
    const storage = new MemoryStorage({ conditionalWrites: false });
    const crypto = new IdentityCrypto();
    // Craft a fork directly in storage: two manifests at generation 1.
    const mk = async (device: string, path: string, text: string): Promise<Manifest> => {
      const data = new TextEncoder().encode(text);
      const hash = await crypto.hash(data);
      const objectKey = await crypto.objectKeyFor(hash);
      await storage.put(objectKey, data);
      return {
        version: 1,
        generation: 1,
        device,
        updatedAt: 1000,
        files: { [path]: { hash, size: data.length, mtime: 1000, objectKey } },
        tombstones: {},
      };
    };
    const mA = await mk("aaa-device", "winner.md", "from aaa");
    const mZ = await mk("zzz-device", "loser.md", "from zzz");
    await storage.put(manifestKey(1, "aaa-device"), serializeManifest(mA));
    await storage.put(manifestKey(1, "zzz-device"), serializeManifest(mZ));

    const c = makeDevice(storage, "dev-c");
    await c.engine.pull();
    expect(c.vault.getText("winner.md")).toBe("from aaa"); // winner's content
    expect(c.vault.getText("loser.md")).toBeNull(); // loser ignored as base
  });

  it("a concurrent publish during push is detected; the loser reports pull-first", async () => {
    // Storage WITHOUT conditional writes: fork must be DETECTED via re-list.
    const storage = new MemoryStorage({ conditionalWrites: false });
    const a = makeDevice(storage, "zzz-device"); // larger id ⇒ loses the fork
    a.vault.setFile("mine.md", "z content");

    // Interpose: when zzz publishes its manifest, aaa's manifest for the same
    // generation appears first (the concurrent-publish race).
    const originalPut = storage.put.bind(storage);
    let injected = false;
    storage.put = async (key, data, opts) => {
      if (!injected && key.startsWith("manifests/")) {
        injected = true;
        const other: Manifest = {
          version: 1,
          generation: 1,
          device: "aaa-device",
          updatedAt: 999,
          files: {},
          tombstones: {},
        };
        await originalPut(manifestKey(1, "aaa-device"), serializeManifest(other));
      }
      return originalPut(key, data, opts);
    };

    const report = await a.engine.push();
    expect(report.outcome).toBe("pull-first");
    // No data lost: both manifests and zzz's uploaded object exist in storage.
    expect(storage.keys().filter((k) => k.startsWith("manifests/"))).toHaveLength(2);
    expect(storage.keys().some((k) => k.startsWith("objects/"))).toBe(true);
  });

  it("with conditional writes the fork is still DETECTED via re-list (per-device keys cannot be create-if-absent-guarded — RFC-0006 erratum)", async () => {
    const storage = new MemoryStorage({ conditionalWrites: true });
    const a = makeDevice(storage, "zzz-device");
    a.vault.setFile("mine.md", "z content");

    const originalPut = storage.put.bind(storage);
    let injected = false;
    storage.put = async (key, data, opts) => {
      if (!injected && key.startsWith("manifests/")) {
        injected = true;
        const other: Manifest = {
          version: 1,
          generation: 1,
          device: "aaa-device",
          updatedAt: 999,
          files: {},
          tombstones: {},
        };
        await originalPut(manifestKey(1, "aaa-device"), serializeManifest(other));
      }
      return originalPut(key, data, opts);
    };

    const report = await a.engine.push();
    expect(report.outcome).toBe("pull-first");
    // Both per-device manifests exist (ifNoneMatch guards only the SAME key);
    // safety comes from detection, and no data is lost.
    expect(storage.keys().filter((k) => k.startsWith("manifests/"))).toHaveLength(2);
    expect(storage.keys().some((k) => k.startsWith("objects/"))).toBe(true);
  });
});

describe("fail-closed (RFC-0007 §6/§8.5)", () => {
  it("a corrupted content object is never applied (CryptoAuthError)", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    const b = makeDevice(storage, "dev-b");
    a.vault.setFile("note.md", "true content");
    await a.engine.push();

    const objectKey = storage.keys().find((k) => k.startsWith("objects/"));
    expect(objectKey).toBeDefined();
    await storage.put(objectKey ?? "", new TextEncoder().encode("EVIL BYTES"));

    await expect(b.engine.pull()).rejects.toSatisfy((e) =>
      isSyncError(e, "CryptoAuthError"),
    );
    expect(b.vault.getText("note.md")).toBeNull(); // nothing was written
  });

  it("a corrupt manifest stops the sync (ManifestCorrupt)", async () => {
    const storage = new MemoryStorage();
    const b = makeDevice(storage, "dev-b");
    await storage.put(manifestKey(1, "dev-x"), new TextEncoder().encode("{not json"));
    await expect(b.engine.pull()).rejects.toSatisfy((e) =>
      isSyncError(e, "ManifestCorrupt"),
    );
  });
});

describe("state persistence (ADR-0011) and status", () => {
  it("a restarted engine resumes from the persisted base", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "hello");
    await a.engine.push();

    // "Restart": new engine, same vault + state store.
    const log = new MemoryLog();
    const engine2 = createSyncEngine({
      storage,
      vault: a.vault,
      crypto: new IdentityCrypto(),
      clock: a.clock,
      log,
      state: a.state,
      deviceId: "dev-a",
      storagePrefix: "",
    });
    const status = await engine2.status();
    expect(status.baseGeneration).toBe(1);
    expect(status.dirtyFiles).toBe(0);
    expect((await engine2.pull()).outcome).toBe("no-op");
  });

  it("a corrupt state blob degrades to a safe full reconcile", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "hello");
    await a.engine.push();
    await a.state.save(new TextEncoder().encode("garbage!"));

    const engine2 = createSyncEngine({
      storage,
      vault: a.vault,
      crypto: new IdentityCrypto(),
      state: a.state,
      deviceId: "dev-a",
      storagePrefix: "",
    });
    const status = await engine2.status();
    expect(status.baseGeneration).toBeNull(); // base lost → reconcile
    const pull = await engine2.pull();
    expect(pull.outcome).toBe("no-op"); // reconcile finds everything in sync
    expect((await engine2.status()).baseGeneration).toBe(1);
  });

  it("status counts dirty files", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    a.vault.setFile("clean.md", "same");
    await a.engine.push();
    a.vault.setFile("added.md", "new");
    a.vault.setFile("clean.md", "modified");
    const status = await a.engine.status();
    expect(status.dirtyFiles).toBe(2);
  });
});

describe("dryRun (FR-14)", () => {
  it("computes the plan without touching any file or object", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "hello");
    const before = storage.keys();
    const p = await a.engine.dryRun();
    expect(p.summary.uploads).toBe(1);
    expect(storage.keys()).toEqual(before); // storage untouched
    expect(a.vault.paths()).toEqual(["note.md"]); // vault untouched
  });
});

describe("Safe-Sync version retention (ADR-0010 §3)", () => {
  it("keeps the last K prior versions in manifest history", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a", { safeSync: { versionsToKeep: 2 } });
    a.vault.setFile("note.md", "v1");
    await a.engine.push();
    for (const v of ["v2", "v3", "v4"]) {
      a.vault.now += 10;
      a.vault.setFile("note.md", v);
      await a.engine.sync();
    }
    const crypto = new IdentityCrypto();
    // Read the latest manifest straight from storage.
    const manifests = storage.keys().filter((k) => k.startsWith("manifests/"));
    const latest = manifests[manifests.length - 1];
    const bytes = await storage.get(latest ?? "");
    const m = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
    const history = m.history?.["note.md"] ?? [];
    expect(history).toHaveLength(2); // trimmed to K
    // Each retained version's object still exists and decodes to the old text.
    const texts: string[] = [];
    for (const entry of history) {
      texts.push(new TextDecoder().decode(await storage.get(entry.objectKey)));
    }
    expect(texts).toEqual(["v3", "v2"]); // most recent prior first
    void crypto;
  });
});
