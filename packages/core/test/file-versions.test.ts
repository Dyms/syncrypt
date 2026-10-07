// File history — RFC-0010. The engine can say which versions of a path storage
// holds and hand back the bytes of one of them, verified, without writing
// anything anywhere.

import { describe, expect, it } from "vitest";

import { createSyncEngine, SyncError, type SyncEngine } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

function must<T>(value: T | undefined, what = "value"): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}


function device(storage: MemoryStorage, deviceId = "desktop", vault = new MemoryVault()) {
  const engine: SyncEngine = createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock: new FixedClock(),
    log: new MemoryLog(),
    state: new MemoryStateStore(),
    deviceId,
    storagePrefix: "",
  });
  return { engine, vault };
}

// Versions differ in LENGTH on purpose: the hash cache trusts (size, mtime),
// and the in-memory vault gives every write the same mtime.
async function edited(storage: MemoryStorage, versions: string[]) {
  const d = device(storage);
  for (const v of versions) {
    d.vault.setFile("note.md", v);
    await d.engine.sync();
  }
  return d;
}

describe("listFileVersions", () => {
  it("lists the current version first, then the retained ones newest first", async () => {
    const storage = new MemoryStorage();
    const d = await edited(storage, ["v1", "v22", "v333", "v4444"]);
    const { deleted, versions } = await d.engine.listFileVersions("note.md");
    expect(deleted).toBe(false);
    expect(versions.map((v) => v.current)).toEqual([true, false, false, false]);
    expect(versions.map((v) => v.size)).toEqual([5, 4, 3, 2]);
  });

  it("a path storage has never seen has no versions", async () => {
    const d = await edited(new MemoryStorage(), ["a"]);
    expect(await d.engine.listFileVersions("nope.md")).toEqual({ deleted: false, versions: [] });
  });

  it("an empty storage is an empty answer, not an error", async () => {
    const d = device(new MemoryStorage());
    expect(await d.engine.listFileVersions("note.md")).toEqual({ deleted: false, versions: [] });
  });

  it("a deleted file is reported as deleted and its last version is still listed", async () => {
    const storage = new MemoryStorage();
    const d = await edited(storage, ["alive and well"]);
    await d.vault.delete("note.md");
    await d.engine.sync();
    const { deleted, versions } = await d.engine.listFileVersions("note.md");
    expect(deleted).toBe(true);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.current).toBe(false);
    expect(versions[0]?.size).toBe("alive and well".length);
  });

  it("is visible from another device (history is shared through the manifest)", async () => {
    const storage = new MemoryStorage();
    await edited(storage, ["one", "two!!", "three!!!"]);
    const phone = device(storage, "phone");
    const { versions } = await phone.engine.listFileVersions("note.md");
    expect(versions).toHaveLength(3);
  });
});

describe("readFileVersion", () => {
  it("returns the bytes of the current and of every retained version", async () => {
    const storage = new MemoryStorage();
    const d = await edited(storage, ["first", "second!", "third!!!"]);
    const { versions } = await d.engine.listFileVersions("note.md");
    const bodies = [];
    for (const v of versions) bodies.push(text(await d.engine.readFileVersion("note.md", v.hash)));
    expect(bodies).toEqual(["third!!!", "second!", "first"]);
  });

  it("returns the last version of a deleted file", async () => {
    const storage = new MemoryStorage();
    const d = await edited(storage, ["remember me"]);
    await d.vault.delete("note.md");
    await d.engine.sync();
    const { versions } = await d.engine.listFileVersions("note.md");
    expect(text(await d.engine.readFileVersion("note.md", must(versions[0]).hash))).toBe("remember me");
  });

  it("SAFETY: refuses a hash the manifest does not name for that path", async () => {
    const storage = new MemoryStorage();
    const d = await edited(storage, ["alpha", "beta!!"]);
    d.vault.setFile("other.md", "secret elsewhere");
    await d.engine.sync();
    const other = must((await d.engine.listFileVersions("other.md")).versions[0]);
    // A real object, in the same storage — but not a version of note.md.
    await expect(d.engine.readFileVersion("note.md", other.hash)).rejects.toMatchObject({
      code: "StorageNotFound",
    });
    await expect(d.engine.readFileVersion("note.md", "blake3:nothing")).rejects.toBeInstanceOf(
      SyncError,
    );
  });

  it("an object that no longer matches its hash is refused, not returned", async () => {
    const storage = new MemoryStorage();
    const d = await edited(storage, ["genuine"]);
    const { versions } = await d.engine.listFileVersions("note.md");
    for (const key of storage.keys().filter((k) => k.startsWith("objects/"))) {
      await storage.put(key, new TextEncoder().encode("tampered"));
    }
    await expect(d.engine.readFileVersion("note.md", must(versions[0]).hash)).rejects.toMatchObject({
      code: "CryptoAuthError",
    });
  });

  it("writes nothing: storage, vault and the manifest generation are unchanged", async () => {
    const storage = new MemoryStorage();
    const d = await edited(storage, ["abc", "abcd", "abcde"]);
    const keysBefore = storage.keys();
    const filesBefore = d.vault.paths();
    const textBefore = d.vault.getText("note.md");
    const { versions } = await d.engine.listFileVersions("note.md");
    for (const v of versions) await d.engine.readFileVersion("note.md", v.hash);
    expect(storage.keys()).toEqual(keysBefore);
    expect(d.vault.paths()).toEqual(filesBefore);
    expect(d.vault.getText("note.md")).toBe(textBefore);
  });

  it("an aborted read does not return data", async () => {
    const storage = new MemoryStorage();
    const d = await edited(storage, ["abc", "abcd"]);
    const { versions } = await d.engine.listFileVersions("note.md");
    const ac = new AbortController();
    ac.abort();
    await expect(
      d.engine.readFileVersion("note.md", must(versions[0]).hash, ac.signal),
    ).rejects.toBeInstanceOf(SyncError);
  });
});
