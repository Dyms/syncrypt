import { describe, expect, it } from "vitest";

import {
  isSyncError,
  manifestKey,
  parseManifest,
  parseManifestKey,
  serializeManifest,
  type Manifest,
} from "../src/index.js";
import { manifest } from "./helpers.js";

describe("manifest keys (ADR-0006)", () => {
  it("round-trips generation and device", () => {
    const key = manifestKey(42, "0b6e-dev");
    expect(key).toBe("manifests/000000042-0b6e-dev.json");
    expect(parseManifestKey(key)).toEqual({ generation: 42, device: "0b6e-dev" });
  });

  it("zero-pads so lexicographic order equals numeric order", () => {
    expect(manifestKey(9, "d") < manifestKey(10, "d")).toBe(true);
    expect(manifestKey(99, "d") < manifestKey(100, "d")).toBe(true);
  });

  it("rejects invalid generations and foreign keys", () => {
    expect(() => manifestKey(0, "d")).toThrow();
    expect(parseManifestKey("objects/ab/cd")).toBeNull();
    expect(parseManifestKey("manifests/notanumber-d.json")).toBeNull();
    expect(parseManifestKey("manifests/000000001-d.txt")).toBeNull();
  });
});

describe("manifest serialization", () => {
  it("round-trips through serialize/parse", () => {
    const m = manifest({
      generation: 7,
      files: { "a.md": "b3:aa", "dir/b.md": "b3:bb" },
      tombstones: ["gone.md"],
    });
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });

  it("is canonical: key insertion order does not change the bytes", () => {
    const m1 = manifest({ files: { "a.md": "b3:aa", "b.md": "b3:bb" } });
    const m2 = manifest({ files: { "b.md": "b3:bb", "a.md": "b3:aa" } });
    expect(serializeManifest(m1)).toEqual(serializeManifest(m2));
  });

  it("round-trips history (Safe Sync version retention)", () => {
    const m = manifest({ files: { "a.md": "b3:a2" } });
    m.history = { "a.md": [{ hash: "b3:a1", size: 1, mtime: 900, objectKey: "objects/b3-a1" }] };
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });
});

describe("parseManifest fails closed (ManifestCorrupt)", () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

  function expectCorrupt(v: unknown) {
    try {
      parseManifest(v instanceof Uint8Array ? v : enc(v));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isSyncError(e, "ManifestCorrupt"), String(e)).toBe(true);
    }
  }

  const valid = (): Manifest => manifest({ files: { "a.md": "b3:aa" } });

  it("rejects garbage bytes and non-objects", () => {
    expectCorrupt(new Uint8Array([0xff, 0xfe, 0x00]));
    expectCorrupt("just a string");
    expectCorrupt([1, 2, 3]);
  });

  it("rejects wrong version / generation / device / timestamps", () => {
    expectCorrupt({ ...valid(), version: 2 });
    expectCorrupt({ ...valid(), generation: 0 });
    expectCorrupt({ ...valid(), generation: 1.5 });
    expectCorrupt({ ...valid(), device: "" });
    expectCorrupt({ ...valid(), updatedAt: "yesterday" });
  });

  it("rejects malformed entries and tombstones", () => {
    expectCorrupt({ ...valid(), files: { "a.md": { hash: "nohash" } } });
    expectCorrupt({ ...valid(), files: { "a.md": { hash: "b3:aa", size: -1, mtime: 1, objectKey: "k" } } });
    expectCorrupt({ ...valid(), tombstones: { "t.md": { deletedAt: "never", device: "d" } } });
  });

  it("rejects non-canonical paths and live+tombstoned duplicates", () => {
    expectCorrupt({ ...valid(), files: { "../evil.md": { hash: "b3:aa", size: 1, mtime: 1, objectKey: "k" } } });
    expectCorrupt({ ...valid(), files: { "dir\\a.md": { hash: "b3:aa", size: 1, mtime: 1, objectKey: "k" } } });
    const m = valid();
    expectCorrupt({ ...m, tombstones: { "a.md": { deletedAt: 1, device: "d" } } });
  });
});
