// ADR-0044. A device id read back OUT of storage is a name the storage chose.
//
// It round-trips through `manifestKey()` into a DELETE, and — from inside a
// manifest — into the filename of a conflicted copy written to the vault. Both
// used to accept "anything at all": `(.+)` in the key parser, "a non-empty
// string" in the body parser.

import { describe, expect, it } from "vitest";

import { manifestKey, parseManifest, parseManifestKey } from "../src/manifest.js";

const manifest = (device: unknown): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({ version: 1, generation: 1, device, updatedAt: 1_000_000, files: {}, tombstones: {} }),
  );

describe("a device id in a manifest KEY", () => {
  it("is a device id, not a path", () => {
    expect(parseManifestKey("manifests/000000001-dev-abc123.json")).toEqual({
      generation: 1,
      device: "dev-abc123",
    });
    for (const bad of [
      "manifests/000000001-../../../../Documents/Taxes.json",
      "manifests/000000001-a/b.json",
      "manifests/000000001-...json",
      `manifests/000000001-${"x".repeat(65)}.json`,
    ]) {
      expect(parseManifestKey(bad), bad).toBeNull();
    }
  });

  it("older, plainer ids still parse", () => {
    // Widening the charset later is easy; a vault that stops being readable is
    // not. Anything a previous version could have generated must still work.
    for (const id of ["dev-0011223344556677", "A", "device.1", "a_b-c.d"]) {
      expect(parseManifestKey(`manifests/000000007-${id}.json`)?.device, id).toBe(id);
    }
  });

  it("cannot be BUILT into a path either", () => {
    expect(() => manifestKey(1, "../../escape")).toThrow(/invalid device/);
    expect(manifestKey(1, "dev-abc")).toBe("manifests/000000001-dev-abc.json");
  });
});

describe("a device id in a manifest BODY", () => {
  it("is refused when it could steer a conflicted copy out of its folder", () => {
    // `conflictedCopyPath` interpolates it into a filename and writes it with
    // no re-canonicalization.
    for (const bad of ["../../escape", "a/b", "", "x".repeat(65)]) {
      expect(() => parseManifest(manifest(bad)), JSON.stringify(bad)).toThrow(/invalid device/);
    }
    expect(() => parseManifest(manifest(42))).toThrow(/invalid device/);
  });

  it("an ordinary one is accepted", () => {
    expect(parseManifest(manifest("dev-0011223344556677")).device).toBe("dev-0011223344556677");
  });

  it("a tombstone's device is held to the same rule", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        version: 1, generation: 1, device: "dev-a", updatedAt: 1_000_000, files: {},
        tombstones: { "note.md": { deletedAt: 1_000_000, device: "../../escape" } },
      }),
    );
    expect(() => parseManifest(bytes)).toThrow(/invalid device/);
  });
});
