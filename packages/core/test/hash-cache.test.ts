// Persistent incremental hash cache — ADR-0023.
//
// The promise under test: restarting the process must not re-read and re-hash
// a vault that has not changed, and no cached hash may ever survive a change
// to the file it describes.

import { describe, expect, it } from "vitest";

import {
  createSyncEngine,
  decodeHashCache,
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

interface Device {
  engine: SyncEngine;
  vault: MemoryVault;
  state: MemoryStateStore;
  clock: FixedClock;
}

/** A device whose state store (and therefore its cache) can outlive it. */
function makeDevice(
  storage: MemoryStorage,
  deviceId: string,
  state = new MemoryStateStore(),
  vault = new MemoryVault(),
  clock = new FixedClock(),
): Device {
  const engine = createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock,
    log: new MemoryLog(),
    state,
    deviceId,
    storagePrefix: "",
  });
  return { engine, vault, state, clock };
}

describe("scanVault + HashCache", () => {
  it("re-uses the cached hash while size and mtime hold, and only then", async () => {
    const vault = new MemoryVault();
    const crypto = new IdentityCrypto();
    const cache: HashCache = new Map();
    vault.setFile("a.md", "alpha");
    vault.setFile("b.md", "beta");

    const first = await scanVault(vault, crypto, cache);
    expect(vault.reads).toEqual(["a.md", "b.md"]);
    expect(cache.size).toBe(2);

    // Nothing touched: a second scan reads no file at all.
    vault.reads.length = 0;
    const second = await scanVault(vault, crypto, cache);
    expect(vault.reads).toEqual([]);
    expect(second).toEqual(first);

    // Same size, NEW mtime: the entry must not be trusted.
    vault.now += 60;
    vault.setFile("a.md", "ALPHA");
    vault.reads.length = 0;
    const third = await scanVault(vault, crypto, cache);
    expect(vault.reads).toEqual(["a.md"]);
    expect(third.find((f) => f.path === "a.md")?.hash).not.toBe(
      first.find((f) => f.path === "a.md")?.hash,
    );
  });

  it("a completed scan forgets paths that are gone; an aborted one keeps them", async () => {
    const vault = new MemoryVault();
    const crypto = new IdentityCrypto();
    const cache: HashCache = new Map();
    vault.setFile("keep.md", "x");
    vault.setFile("drop.md", "y");
    await scanVault(vault, crypto, cache);
    expect([...cache.keys()].sort()).toEqual(["drop.md", "keep.md"]);

    await vault.delete("drop.md");
    await scanVault(vault, crypto, cache);
    expect([...cache.keys()]).toEqual(["keep.md"]);

    // An aborted scan saw only a prefix of the vault: pruning there would
    // evict live entries and cost a full re-hash on the next run.
    vault.setFile("later.md", "z");
    await scanVault(vault, crypto, cache);
    const controller = new AbortController();
    controller.abort();
    await scanVault(vault, crypto, cache, controller.signal);
    expect([...cache.keys()].sort()).toEqual(["keep.md", "later.md"]);
  });
});

describe("encode / decode", () => {
  it("round-trips settled entries", () => {
    const cache: HashCache = new Map([
      ["b.md", { size: 2, mtime: 100, hash: "h:b" }],
      ["a.md", { size: 1, mtime: 100, hash: "h:a" }],
    ]);
    const encoded = encodeHashCache(cache, 1_000);
    expect(encoded.entries.map((e) => e[0])).toEqual(["a.md", "b.md"]); // sorted
    expect(decodeHashCache(encoded)).toEqual(
      new Map([
        ["a.md", { size: 1, mtime: 100, hash: "h:a" }],
        ["b.md", { size: 2, mtime: 100, hash: "h:b" }],
      ]),
    );
  });

  it("RACE: a hash for a file touched in this same tick is never persisted", () => {
    const cache: HashCache = new Map([
      ["settled.md", { size: 1, mtime: 900, hash: "h:old" }],
      ["just-now.md", { size: 1, mtime: 1_000, hash: "h:fresh" }],
    ]);
    // A write landing in the same timestamp tick with the same size would be
    // invisible to a (size, mtime) key — so that entry does not get saved.
    expect(encodeHashCache(cache, 1_000).entries.map((e) => e[0])).toEqual(["settled.md"]);
  });

  it("garbage decodes to an empty or partial cache, never an exception", () => {
    expect(decodeHashCache(undefined).size).toBe(0);
    expect(decodeHashCache(null).size).toBe(0);
    expect(decodeHashCache("nope").size).toBe(0);
    expect(decodeHashCache({ version: 9, entries: [] }).size).toBe(0);
    expect(decodeHashCache({ version: 1, entries: "no" }).size).toBe(0);
    const partial = decodeHashCache({
      version: 1,
      entries: [
        ["ok.md", 1, 2, "h:ok"],
        ["short.md", 1, 2],
        ["", 1, 2, "h:x"],
        ["bad-size.md", -1, 2, "h:x"],
        ["nan.md", 1, Number.NaN, "h:x"],
        ["no-hash.md", 1, 2, ""],
        "not-an-array",
      ],
    });
    expect([...partial.keys()]).toEqual(["ok.md"]);
  });
});

describe("engine state blob", () => {
  it("a restarted device re-uses the persisted hashes instead of re-hashing", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "hello");
    a.vault.setFile("dir/deep.md", "world");
    a.clock.advance(60); // the files are settled, not written this very tick
    await a.engine.push();

    // Same vault, same state store, a brand-new engine: the process restarted.
    const restarted = makeDevice(storage, "dev-a", a.state, a.vault, a.clock);
    a.vault.reads.length = 0;
    await restarted.engine.push();
    expect(a.vault.reads).toEqual([]);

    // And the cache still tells the truth: an edit is seen.
    a.vault.now += 60;
    a.clock.advance(60);
    a.vault.setFile("note.md", "HELLO");
    a.vault.reads.length = 0;
    const report = await restarted.engine.push();
    expect(a.vault.reads).toContain("note.md");
    expect(report.entries.map((e) => e.path)).toContain("note.md");
  });

  it("a first sync remembers what it downloaded, and the next start re-uses it", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "hello");
    a.clock.advance(60);
    await a.engine.push();

    const b = makeDevice(storage, "dev-b");
    await b.engine.pull();
    expect(b.vault.getText("note.md")).toBe("hello");

    // Downloaded bytes are hashed once, on the way in: the next scan in this
    // session re-reads nothing.
    b.vault.reads.length = 0;
    await b.engine.pull();
    expect(b.vault.reads).toEqual([]);

    // Those hashes are too fresh to persist on the sync that produced them
    // (a write in the same tick would be invisible), so they land on the next
    // state save — which any later sync performs.
    b.clock.advance(60);
    b.vault.now += 60;
    await b.engine.pull();

    const restarted = makeDevice(storage, "dev-b", b.state, b.vault, b.clock);
    b.vault.reads.length = 0;
    await restarted.engine.pull();
    expect(b.vault.reads).toEqual([]);
  });

  it("state written by version 1 still loads; the cache just starts empty", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "hello");
    a.clock.advance(60);
    await a.engine.push();

    // Rewrite the blob in the old shape: base only, no hashes.
    const blob = await a.state.load();
    expect(blob).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(blob ?? new Uint8Array())) as {
      base: unknown;
    };
    await a.state.save(
      new TextEncoder().encode(JSON.stringify({ version: 1, base: parsed.base })),
    );

    const restarted = makeDevice(storage, "dev-a", a.state, a.vault, a.clock);
    a.vault.reads.length = 0;
    const report = await restarted.engine.push();
    expect(a.vault.reads).toEqual(["note.md"]); // re-hashed once
    expect(report.outcome).toBe("no-op"); // base survived: nothing to publish
  });

  it("a quiet sync does not rewrite an identical state blob", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "hello");
    a.clock.advance(60);
    await a.engine.push();
    const afterPush = a.state.saves;
    expect(afterPush).toBeGreaterThan(0);

    // Nothing changed anywhere: the bytes would be identical, so they are not
    // written. On a big vault this blob is the largest file we touch.
    await a.engine.pull();
    await a.engine.pull();
    expect(a.state.saves).toBe(afterPush);

    // A real change still lands.
    a.vault.now += 60;
    a.clock.advance(60);
    a.vault.setFile("note.md", "HELLO");
    await a.engine.push();
    expect(a.state.saves).toBe(afterPush + 1);
  });

  it("an unreadable hash list never costs us the base manifest", async () => {
    const storage = new MemoryStorage();
    const a = makeDevice(storage, "dev-a");
    a.vault.setFile("note.md", "hello");
    a.clock.advance(60);
    await a.engine.push();
    const gen = (await a.engine.status()).baseGeneration;

    const blob = await a.state.load();
    expect(blob).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(blob ?? new Uint8Array())) as {
      base: unknown;
    };
    await a.state.save(
      new TextEncoder().encode(
        JSON.stringify({ version: 2, base: parsed.base, hashes: { version: 1, entries: 42 } }),
      ),
    );

    const restarted = makeDevice(storage, "dev-a", a.state, a.vault, a.clock);
    expect((await restarted.engine.status()).baseGeneration).toBe(gen);
  });
});
