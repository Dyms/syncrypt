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
  /**
   * Keys this provider returns per page, as the harness CONFIGURED it.
   *
   * The pagination test writes more than two pages of keys, so the
   * continuation branch runs and runs more than once. Left unset it assumes
   * 25, which the earlier fixed count of 60 happened to satisfy for nobody:
   * with the S3 page size at its production 1000, that test wrote 60 objects
   * and proved that one page works, while the defect it existed to catch — a
   * truncated listing reported as complete — sat underneath it (ADR-0058).
   */
  listPageSize?: number;
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

    it("round-trips keys that need percent-encoding", async () => {
      // Every one of these is a legal object key, and every one of them has to
      // survive being turned into a URL, sent, and read back out of a listing.
      //
      // What this CANNOT prove is that the request was canonicalized the way
      // the backend's signature check will canonicalize it. A test backend
      // that does not verify signatures — moto, and most local doubles —
      // accepts a query encoded any way at all, and a form-encoded space
      // round-trips through it perfectly while a real S3 answers 403. That
      // half belongs to a provider's own suite, at the wire (ADR-0052).
      const keys = [
        "objects/a b/one",
        "objects/a+b/one",
        "objects/a~b/one",
        "objects/a&b/one",
        "objects/a=b/one",
        "objects/a%b/one",
        "objects/Заметки/one",
        "objects/naïve/one",
      ];
      for (const key of keys) await storage.put(key, enc(key));
      for (const key of keys) {
        expect(dec(await storage.get(key)), key).toBe(key);
        expect((await storage.stat(key)).key, key).toBe(key);
      }
      const listed: string[] = [];
      for await (const stat of storage.list("objects/")) listed.push(stat.key);
      expect(listed.sort()).toEqual([...keys].sort());
    });

    it("lists under a prefix that needs percent-encoding", async () => {
      await storage.put("Мои заметки/manifests/000000001-devA.json", enc("mine"));
      await storage.put("other/manifests/000000001-devA.json", enc("theirs"));
      const listed: string[] = [];
      for await (const stat of storage.list("Мои заметки/manifests/")) listed.push(stat.key);
      // Not a subset, not empty: an under-reporting listing on manifests/ is
      // read as a lower generation, which is an ADR-0038 refusal for ever on a
      // device that has a base and an empty vault on one that does not. Same
      // caveat as above — a backend that does not check signatures will pass
      // this while a real one refuses the request outright.
      expect(listed).toEqual(["Мои заметки/manifests/000000001-devA.json"]);
    });

    it("a zero-byte object is an object", async () => {
      const put = await storage.put("objects/empty", new Uint8Array(0));
      const stat = await storage.stat("objects/empty");
      expect(stat.size).toBe(0);
      expect(await storage.get("objects/empty")).toEqual(new Uint8Array(0));
      const listed: Record<string, number> = {};
      for await (const s of storage.list("objects/")) listed[s.key] = s.size;
      expect(listed).toEqual({ "objects/empty": 0 });

      // AND IT HAS AN ETAG. S3 answers a byte-range request on a zero-byte
      // object with 416 and no ETag, and the provider that read the size out
      // of that answer reported `etag: ""` with it — against which every
      // conditional write compares equal to nothing (ADR-0056). An empty
      // object is the one an engine writes for an empty note, so this is not
      // a corner.
      expect(stat.etag.length).toBeGreaterThan(0);
      expect(stat.etag).toBe(put.etag);
      expect(stat.key).toBe("objects/empty");
    });

    it("STAT AND LIST ANSWER ABOUT THE KEY THAT WAS ASKED FOR", async () => {
      // Callers slice the configured prefix off a listed key and hand the rest
      // back to get/delete, so a key that is a suffix, a relative name, or
      // somebody else's is not caught as foreign — it is used.
      await storage.put("vaults/main/objects/aa/one", enc("mine"));
      expect((await storage.stat("vaults/main/objects/aa/one")).key).toBe(
        "vaults/main/objects/aa/one",
      );
      for await (const stat of storage.list("vaults/main/objects/")) {
        expect(stat.key).toBe("vaults/main/objects/aa/one");
        expect(dec(await storage.get(stat.key))).toBe("mine");
      }
    });

    it("LIST TAKES A KEY PREFIX, AND NOTHING OUTSIDE IT COMES BACK", async () => {
      // "a/" and "ab/" are neighbours no engine would confuse, and a provider
      // that filters by directory rather than by key prefix hands one vault's
      // objects to another vault's reclamation.
      await storage.put("a/1", enc("x"));
      await storage.put("ab/1", enc("x"));
      await storage.put("a-/1", enc("x"));
      const under = async (prefix: string): Promise<string[]> => {
        const keys: string[] = [];
        for await (const stat of storage.list(prefix)) keys.push(stat.key);
        return keys.sort();
      };
      expect(await under("a/")).toEqual(["a/1"]);
      expect(await under("ab/")).toEqual(["ab/1"]);
      // A key prefix, not a path prefix: "a" is a prefix of all three.
      expect(await under("a")).toEqual(["a-/1", "a/1", "ab/1"]);
    });

    it("A LISTING IS A SNAPSHOT ATTEMPT, NOT A SOURCE OF StorageNotFound", async () => {
      // Two devices reclaiming at once, or anyone pruning the bucket, deletes
      // an object while this walk is in flight. RFC-0006 gives `list` no way
      // to say NotFound: the object is simply not in the result. A provider
      // that walks first and stats afterwards reports it instead, and the
      // whole of readRemote or reclamation fails over a key nobody asked
      // about (ADR-0058).
      for (const n of ["a", "b", "c", "d", "e", "f"]) {
        await storage.put(`objects/${n}`, enc(n));
      }
      const seen: string[] = [];
      for await (const stat of storage.list("objects/")) {
        seen.push(stat.key);
        if (seen.length === 1) {
          // Delete the rest, including keys this walk has not reached yet.
          for (const n of ["c", "d", "e", "f"]) await storage.delete(`objects/${n}`);
        }
      }
      // What came back is some subset of what was there — the point is that
      // the walk FINISHED, and that every key it yielded was real when it was
      // yielded.
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen.every((k) => k.startsWith("objects/"))).toBe(true);
      for (const key of seen.slice(0, 2)) expect(key).not.toBe("");
    });

    it("refuses a key with a traversing segment instead of resolving it", async () => {
      // These arrive from a listing, which is the server talking, and go
      // straight into stat/get/delete. `..` normalizes out of a URL and out of
      // a filesystem path alike, so the object acted on is not the one named.
      for (const key of ["objects/../manifests/000000009-devA.json", "objects/./x", "objects//x"]) {
        await expect(storage.put(key, enc("x")), key).rejects.toSatisfy((e) => isSyncError(e));
        await expect(storage.get(key), key).rejects.toSatisfy((e) => isSyncError(e));
        await expect(storage.delete(key), key).rejects.toSatisfy((e) => isSyncError(e));
      }
      // …and nothing was created by any of those attempts.
      const listed: string[] = [];
      for await (const stat of storage.list("")) listed.push(stat.key);
      expect(listed).toEqual([]);
    });

    /**
     * More than TWO pages, measured against the page size the harness says it
     * configured — so the continuation branch runs, and runs again. One page
     * boundary proves a token is sent; two prove it is updated (ADR-0058).
     */
    it("list paginates correctly over more than two pages", async () => {
      const pageSize = harness.listPageSize ?? 25;
      const count = pageSize * 2 + 1;
      const expected: string[] = [];
      for (let i = 0; i < count; i++) {
        const key = `many/${String(i).padStart(4, "0")}`;
        expected.push(key);
        await storage.put(key, enc(String(i)));
      }
      const keys: string[] = [];
      for await (const stat of storage.list("many/")) keys.push(stat.key);
      expect(keys.sort()).toEqual(expected);
      // Not a prefix of the answer, not a page of it: the whole listing. A
      // walk that stops early must raise, never return quietly short.
      expect(keys).toHaveLength(count);
    }, 60_000);

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
