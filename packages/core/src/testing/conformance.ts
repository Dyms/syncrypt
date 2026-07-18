// Provider conformance suite — RFC-0006 §Conformance test suite.
// A new StorageProvider is "done" when it passes this. Runs under vitest.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isSyncError } from "../errors.js";
import type { StoragePort } from "../ports.js";

export interface ConformanceHarness {
  /** A fresh, empty storage for each test. */
  create(): Promise<StoragePort>;
  /** Optional teardown for the storage created by create(). */
  destroy?(storage: StoragePort): Promise<void>;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

export function describeStorageConformance(
  name: string,
  harness: ConformanceHarness,
): void {
  describe(`StorageProvider conformance: ${name}`, () => {
    let storage: StoragePort;

    beforeEach(async () => {
      storage = await harness.create();
    });

    afterEach(async () => {
      await harness.destroy?.(storage);
    });

    it("round-trips put/get, overwrites in place, and byte-preserves content", async () => {
      await storage.put("objects/aa/one", enc("hello"));
      expect(dec(await storage.get("objects/aa/one"))).toBe("hello");
      await storage.put("objects/aa/one", enc("goodbye"));
      expect(dec(await storage.get("objects/aa/one"))).toBe("goodbye");
      const binary = new Uint8Array([0, 1, 2, 255, 254, 127]);
      await storage.put("objects/bin", binary);
      expect(await storage.get("objects/bin")).toEqual(binary);
    });

    it("get/stat of a missing key normalize to StorageNotFound", async () => {
      await expect(storage.get("missing/key")).rejects.toSatisfy((e) =>
        isSyncError(e, "StorageNotFound"),
      );
      await expect(storage.stat("missing/key")).rejects.toSatisfy((e) =>
        isSyncError(e, "StorageNotFound"),
      );
    });

    it("stat reports size and an etag that changes when content changes", async () => {
      const r1 = await storage.put("k", enc("aaaa"));
      const s1 = await storage.stat("k");
      expect(s1.key).toBe("k");
      expect(s1.size).toBe(4);
      expect(s1.etag).toBe(r1.etag);
      expect(s1.etag.length).toBeGreaterThan(0);
      const r2 = await storage.put("k", enc("bbbbbb"));
      const s2 = await storage.stat("k");
      expect(s2.size).toBe(6);
      expect(s2.etag).toBe(r2.etag);
      expect(s2.etag).not.toBe(s1.etag);
    });

    it("list returns exactly the keys under a prefix", async () => {
      await storage.put("a/1", enc("x"));
      await storage.put("a/2", enc("x"));
      await storage.put("a/sub/3", enc("x"));
      await storage.put("b/4", enc("x"));
      const under = async (prefix: string): Promise<string[]> => {
        const keys: string[] = [];
        for await (const stat of storage.list(prefix)) keys.push(stat.key);
        return keys.sort();
      };
      expect(await under("a/")).toEqual(["a/1", "a/2", "a/sub/3"]);
      expect(await under("b/")).toEqual(["b/4"]);
      expect(await under("")).toEqual(["a/1", "a/2", "a/sub/3", "b/4"]);
      expect(await under("nope/")).toEqual([]);
    });

    it("list paginates correctly over many keys", async () => {
      const expected: string[] = [];
      for (let i = 0; i < 60; i++) {
        const key = `many/${String(i).padStart(3, "0")}`;
        expected.push(key);
        await storage.put(key, enc(String(i)));
      }
      const keys: string[] = [];
      for await (const stat of storage.list("many/")) keys.push(stat.key);
      expect(keys.sort()).toEqual(expected);
    });

    it("delete removes the object and is idempotent", async () => {
      await storage.put("k", enc("x"));
      await storage.delete("k");
      await expect(storage.get("k")).rejects.toSatisfy((e) =>
        isSyncError(e, "StorageNotFound"),
      );
      await expect(storage.delete("k")).resolves.toBeUndefined(); // missing ≠ error
      await expect(storage.delete("never-existed")).resolves.toBeUndefined();
    });

    it("honors conditional writes exactly when capabilities() says so", async () => {
      const caps = storage.capabilities();
      expect(typeof caps.conditionalWrites).toBe("boolean");
      expect(typeof caps.objectVersioning).toBe("boolean");
      expect(caps.maxSinglePutBytes).toBeGreaterThan(0);

      if (!caps.conditionalWrites) return; // options are ignored — nothing to probe

      // create-if-absent
      await storage.put("cw", enc("v1"), { ifNoneMatch: "*" });
      await expect(
        storage.put("cw", enc("v2"), { ifNoneMatch: "*" }),
      ).rejects.toSatisfy((e) => isSyncError(e, "StoragePreconditionFailed"));
      expect(dec(await storage.get("cw"))).toBe("v1");

      // compare-and-swap
      const { etag } = await storage.put("cw", enc("v2"));
      await expect(
        storage.put("cw", enc("v3"), { ifMatch: '"bogus-etag"' }),
      ).rejects.toSatisfy((e) => isSyncError(e, "StoragePreconditionFailed"));
      expect(dec(await storage.get("cw"))).toBe("v2");
      await storage.put("cw", enc("v3"), { ifMatch: etag });
      expect(dec(await storage.get("cw"))).toBe("v3");
    });
  });
}
