// ADR-0053. Canonicalization is not injective: two files of one vault can
// arrive at the same path, and the manifest has room for one of them.
//
// Taking either was a coin toss nobody saw — the loser was never uploaded, and
// a later scan could pick the other one, so the same key changed content on
// every sync. Reporting them as ABSENT would have been worse: that reads as a
// local deletion and tombstones the entry for every device.

import { describe, expect, it } from "vitest";

import { createSyncEngine, scanVault, type SyncEngine, type VaultPath } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

const NFC = "café.md" as VaultPath; // é as one code point
const NFD = "café.md" as VaultPath; // e + combining acute

/**
 * Three spellings of ONE character, for the three-way case. "café" has only
 * two, so a third literal of it is byte-identical to one of these — which is
 * what the three-file test used to do: `setFile` is keyed by the exact string,
 * so the third write overwrote the second and the test had TWO files
 * (ADR-0061). U+1E09 (c with cedilla and acute) has four.
 */
const THREE = [
  "\u1e09.md", // composed
  "c\u0327\u0301.md", // c + cedilla + acute
  "\u00e7\u0301.md", // ç + acute
] as VaultPath[];

// MemoryVault keys files by the exact string, so it already keeps the
// spellings apart the way Linux and Android do. A subclass that overrode
// list() to yield exactly what the base yields used to sit here and read as
// if it added that (ADR-0061).

function device(
  storage: MemoryStorage,
  id: string,
  vault: MemoryVault,
): { engine: SyncEngine; vault: MemoryVault; log: MemoryLog } {
  const log = new MemoryLog();
  return {
    engine: createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock: new FixedClock(),
      log,
      state: new MemoryStateStore(),
      deviceId: id,
      storagePrefix: "",
    }),
    vault,
    log,
  };
}

describe("scanVault and two files that canonicalize to one path", () => {
  it("reports neither, and says which path is ambiguous", async () => {
    const vault = new MemoryVault();
    vault.setFile(NFD, "the decomposed one");
    vault.setFile(NFC, "the precomposed one, of a different length");
    vault.setFile("plain.md", "unaffected");

    const ambiguous = new Set<VaultPath>();
    const scan = await scanVault(vault, new IdentityCrypto(), undefined, undefined, ambiguous);

    expect(scan.map((f) => f.path)).toEqual(["plain.md"]);
    expect([...ambiguous]).toEqual([NFC]);
  });

  it("KNOWN LIMIT: a lone name only the native side can address is not synced", async () => {
    // Only the decomposed spelling exists. list() yields it, canonicalization
    // turns it into the composed one, and stat() of THAT finds nothing — the
    // file is quietly not backed up. It is not the collision this ADR fixes:
    // nothing is overwritten and no wrong key is published. Nor is it fixable
    // here — whether a filesystem folds normalization is the adapter's
    // knowledge, and a string round-trip test would exclude every accented
    // filename on macOS, where the folding makes them work today. Pinned so
    // the limit is visible rather than folklore (ADR-0053 §Consequences).
    const vault = new MemoryVault();
    vault.setFile(NFD, "only the decomposed one");
    const ambiguous = new Set<VaultPath>();
    const scan = await scanVault(vault, new IdentityCrypto(), undefined, undefined, ambiguous);
    expect(scan).toEqual([]);
    expect([...ambiguous]).toEqual([]);
  });

  it("an ordinary vault is unaffected", async () => {
    const vault = new MemoryVault();
    vault.setFile("a.md", "one");
    vault.setFile("dir/b.md", "two");
    const ambiguous = new Set<VaultPath>();
    const scan = await scanVault(vault, new IdentityCrypto(), undefined, undefined, ambiguous);
    expect(scan.map((f) => f.path)).toEqual(["a.md", "dir/b.md"]);
    expect([...ambiguous]).toEqual([]);
  });

  it("THREE files on one path are still one ambiguous path", async () => {
    const vault = new MemoryVault();
    expect(new Set(THREE).size).toBe(3); // three byte strings…
    expect(new Set(THREE.map((p) => p.normalize("NFC"))).size).toBe(1); // …one path
    THREE.forEach((p, i) => {
      vault.setFile(p, `version ${String(i)}, of its own length${"!".repeat(i)}`);
    });

    const ambiguous = new Set<VaultPath>();
    const scan = await scanVault(vault, new IdentityCrypto(), undefined, undefined, ambiguous);

    expect(scan).toEqual([]);
    expect([...ambiguous]).toEqual([THREE[0]?.normalize("NFC")]);
  });
});

describe("the engine excludes an ambiguous path instead of deleting it", () => {
  it("A COLLIDING PATH ALREADY IN THE MANIFEST IS NOT TOMBSTONED", async () => {
    const storage = new MemoryStorage();

    // A device with one spelling publishes the file.
    const first = device(storage, "first", new MemoryVault());
    first.vault.setFile(NFC, "the published version");
    await first.engine.sync();

    // A second device ends up with both spellings on disk.
    const second = device(storage, "second", new MemoryVault());
    await second.engine.sync();
    expect(second.vault.getText(NFC)).toBe("the published version");
    second.vault.now += 10;
    second.vault.setFile(NFD, "a second file that normalizes onto the first");

    const report = await second.engine.sync();

    // The manifest entry survives: it is not this device's to delete just
    // because it can no longer tell which local file the path means.
    expect(report.entries.filter((e) => e.kind === "delete-remote")).toEqual([]);
    expect(second.log.notices.some((n) => n.code === "paths-not-distinct")).toBe(true);

    const fresh = device(storage, "fresh", new MemoryVault());
    await fresh.engine.sync();
    expect(fresh.vault.getText(NFC)).toBe("the published version");
  });

  it("and neither file is uploaded under the guess", async () => {
    const storage = new MemoryStorage();
    const d = device(storage, "d", new MemoryVault());
    d.vault.setFile(NFD, "one");
    d.vault.setFile(NFC, "two, of a different length");
    d.vault.setFile("plain.md", "unaffected");

    const report = await d.engine.sync();

    expect(report.entries.map((e) => e.path)).toEqual(["plain.md"]);
    const notice = d.log.notices.find((n) => n.code === "paths-not-distinct");
    expect(notice).toEqual({ code: "paths-not-distinct", paths: [NFC] });
  });

  it("status() does not count an ambiguous path as a pending change", async () => {
    const storage = new MemoryStorage();
    const d = device(storage, "d", new MemoryVault());
    d.vault.setFile("plain.md", "unaffected");
    await d.engine.sync();

    d.vault.now += 10;
    d.vault.setFile(NFD, "one");
    d.vault.setFile(NFC, "two, of a different length");

    expect((await d.engine.status()).dirtyFiles).toBe(0);
  });

  it("once one of them is renamed, the other syncs normally", async () => {
    const storage = new MemoryStorage();
    const d = device(storage, "d", new MemoryVault());
    d.vault.setFile(NFD, "one");
    d.vault.setFile(NFC, "two, of a different length");
    await d.engine.sync();
    expect(d.log.notices.some((n) => n.code === "paths-not-distinct")).toBe(true);

    await d.vault.delete(NFD);
    d.vault.now += 10;
    const report = await d.engine.sync();
    expect(report.entries.map((e) => e.path)).toEqual([NFC]);
  });
});
