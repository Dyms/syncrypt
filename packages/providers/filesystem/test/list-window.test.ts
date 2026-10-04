// ADR-0058. `list()` walks to a set of names and then stats them one at a
// time, which opens a window the conformance suite can name but not inject
// into: between the two, another device deletes an object (ordinary — the
// listing simply does not include it) or the disk refuses to answer about one
// (not ordinary — and a listing that quietly drops it under-reports the
// vault). RFC-0006 gives `list` no way to say NotFound; it says nothing about
// hiding every other failure, and hiding them is the worse half.
//
// A listing short on `manifests/` reads as a LOWER generation: an ADR-0038
// refusal for ever on a device that has a base, an empty vault on one that
// does not.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isSyncError, SyncError, type ObjectStat } from "@syncrypt/core";

import { FilesystemStorage } from "../src/index.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function storageWith(keys: string[]): Promise<FilesystemStorage> {
  const root = await mkdtemp(path.join(tmpdir(), "syncrypt-list-window-"));
  roots.push(root);
  const storage = new FilesystemStorage(root);
  for (const key of keys) await storage.put(key, enc(key));
  return storage;
}

/** Replace stat for ONE key — the failure the real disk would give there. */
function statFailsFor(
  storage: FilesystemStorage,
  key: string,
  error: SyncError,
): FilesystemStorage {
  const real = storage.stat.bind(storage);
  storage.stat = (k: string): Promise<ObjectStat> =>
    k === key ? Promise.reject(error) : real(k);
  return storage;
}

const walk = async (storage: FilesystemStorage, prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  for await (const stat of storage.list(prefix)) keys.push(stat.key);
  return keys;
};

describe("the window between the walk and the stat", () => {
  it("a key that vanished is not in the listing, and the walk completes", async () => {
    const storage = await storageWith(["manifests/a", "manifests/b", "manifests/c"]);
    statFailsFor(storage, "manifests/b", new SyncError("StorageNotFound", "gone"));
    expect(await walk(storage, "manifests/")).toEqual(["manifests/a", "manifests/c"]);
  });

  it("A REAL FAILURE ENDS THE WALK INSTEAD OF SHORTENING THE LISTING", async () => {
    // Treating this as a vanish is how a complete-looking listing comes back
    // missing a manifest nobody deleted.
    const storage = await storageWith(["manifests/a", "manifests/b"]);
    statFailsFor(storage, "manifests/b", new SyncError("StorageUnauthorized", "EACCES"));

    await expect(walk(storage, "manifests/")).rejects.toSatisfy((e) =>
      isSyncError(e, "StorageUnauthorized"),
    );
  });

  it("and a transient one does too — a short listing is not an answer", async () => {
    const storage = await storageWith(["objects/a", "objects/b"]);
    statFailsFor(storage, "objects/a", new SyncError("StorageTransient", "EIO"));
    await expect(walk(storage, "objects/")).rejects.toSatisfy((e) =>
      isSyncError(e, "StorageTransient"),
    );
  });
});
