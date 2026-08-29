// The limits of a (size, mtime) hash cache, stated as tests — ADR-0023.
//
// A cache that can be wrong is only acceptable if the ways it can be wrong are
// known, bounded, and escapable. These pin down exactly one hazard and its
// escape hatch, so neither can be lost by accident.

import { describe, expect, it } from "vitest";

import {
  createSyncEngine,
  encodeHashCache,
  scanVault,
  type HashCache,
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

function engineFor(
  storage: MemoryStorage,
  vault: MemoryVault,
  state: MemoryStateStore,
  clock: FixedClock,
): SyncEngine {
  return createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock,
    log: new MemoryLog(),
    state,
    deviceId: "dev-a",
    storagePrefix: "",
  });
}

describe("what the cache cannot see", () => {
  it("KNOWN LIMIT: content replaced with the same size AND the same mtime is missed", async () => {
    const vault = new MemoryVault();
    const crypto = new IdentityCrypto();
    const cache: HashCache = new Map();
    vault.setFile("note.md", "aaaaa");
    const first = await scanVault(vault, crypto, cache);

    // What a restore does: same length, mtime put back to the original.
    // `rsync --times`, `restic restore`, a backup tool, another sync client.
    const mtime = (await vault.stat("note.md"))?.mtime ?? 0;
    vault.now = mtime;
    vault.setFile("note.md", "bbbbb");
    const second = await scanVault(vault, crypto, cache);

    // The scan reports the OLD hash. Nothing in (path, size, mtime) differs,
    // so no cache can tell these apart. This is the documented trade-off, not
    // an accident — and the reason forgetHashCache() exists.
    expect(second[0]?.hash).toBe(first[0]?.hash);
    expect(vault.getText("note.md")).toBe("bbbbb");
  });

  it("…and forgetHashCache() recovers from exactly that, without touching the base", async () => {
    const storage = new MemoryStorage();
    const vault = new MemoryVault();
    const state = new MemoryStateStore();
    const clock = new FixedClock();
    const engine = engineFor(storage, vault, state, clock);

    vault.setFile("note.md", "aaaaa");
    clock.advance(60);
    await engine.sync();
    const generation = (await engine.status()).baseGeneration;
    expect(generation).not.toBeNull();

    const mtime = (await vault.stat("note.md"))?.mtime ?? 0;
    vault.now = mtime;
    vault.setFile("note.md", "bbbbb");
    clock.advance(60);
    expect((await engine.sync()).outcome).toBe("no-op"); // invisible, as above

    await engine.forgetHashCache();
    // The base survives: this is a cache drop, not a reset.
    expect((await engine.status()).baseGeneration).toBe(generation);

    const report = await engine.sync();
    expect(report.entries.map((e) => e.path)).toContain("note.md");
  });

  it("a differing size is always caught, even with the mtime forced back", async () => {
    const vault = new MemoryVault();
    const cache: HashCache = new Map();
    vault.setFile("note.md", "aaaaa");
    const first = await scanVault(vault, new IdentityCrypto(), cache);
    const mtime = (await vault.stat("note.md"))?.mtime ?? 0;
    vault.now = mtime;
    vault.setFile("note.md", "aaaaaa"); // one byte longer
    const second = await scanVault(vault, new IdentityCrypto(), cache);
    expect(second[0]?.hash).not.toBe(first[0]?.hash);
  });

  it("an mtime that moves BACKWARDS (a restore, a clock step) is a miss, not a hit", async () => {
    const vault = new MemoryVault();
    const cache: HashCache = new Map();
    vault.setFile("note.md", "aaaaa");
    await scanVault(vault, new IdentityCrypto(), cache);
    vault.now -= 3600;
    vault.setFile("note.md", "ccccc");
    vault.reads.length = 0;
    await scanVault(vault, new IdentityCrypto(), cache);
    expect(vault.reads).toEqual(["note.md"]);
  });

  it("the persisted cache never carries a hash for a file touched in the same tick", () => {
    const cache: HashCache = new Map([
      ["fresh.md", { size: 1, mtime: 1_000, hash: "h:fresh" }],
      ["settled.md", { size: 1, mtime: 500, hash: "h:settled" }],
    ]);
    // The one window a same-tick overwrite could hide in is the one that is
    // never written to disk.
    expect(encodeHashCache(cache, 1_000).entries.map((e) => e[0])).toEqual(["settled.md"]);
    expect(encodeHashCache(cache, 1_000.5).entries.map((e) => e[0])).toEqual(["settled.md"]);
    expect(encodeHashCache(cache, 1_002).entries.map((e) => e[0])).toEqual([
      "fresh.md",
      "settled.md",
    ]);
  });
});

describe("the cache cannot cause a wrong sync on its own", () => {
  it("a cache full of lies never deletes or overwrites — it only stalls a file", async () => {
    const storage = new MemoryStorage();
    const vault = new MemoryVault();
    const state = new MemoryStateStore();
    const clock = new FixedClock();
    const engine = engineFor(storage, vault, state, clock);

    vault.setFile("a.md", "one");
    vault.setFile("b.md", "two");
    clock.advance(60);
    await engine.sync();

    // Poison the persisted cache with hashes for content that is not there.
    const raw = JSON.parse(
      new TextDecoder().decode((await state.load()) ?? new Uint8Array()),
    ) as { version: number; base: unknown; hashes: { version: number; entries: unknown[] } };
    raw.hashes.entries = raw.hashes.entries.map((row) => {
      const [path, size, mtime] = row as [string, number, number, string];
      return [path, size, mtime, "b3:deadbeef"];
    });
    await state.save(new TextEncoder().encode(JSON.stringify(raw)));

    const restarted = engineFor(storage, vault, state, clock);
    clock.advance(60);
    const report = await restarted.sync();

    // Every file is still on disk with its own content: a bogus hash makes the
    // engine re-upload, never delete or overwrite.
    expect(vault.getText("a.md")).toBe("one");
    expect(vault.getText("b.md")).toBe("two");
    expect(report.entries.every((e) => e.kind !== "delete-remote")).toBe(true);
    expect(vault.trashed).toEqual([]);
  });
});
