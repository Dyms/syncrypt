// ADR-0054. `scanVault` says of itself that a scan is always a snapshot
// attempt, never an error source — and it was, for exactly one of the two
// windows in which a file can disappear.
//
// It handled `list() → stat()`. It did not handle `stat() → read()`, which is
// the next line, and an exception there escapes through pull, push, dryRun and
// status alike: every one of them scans first. On a vault someone is actually
// editing, this happens on its own.

import { describe, expect, it } from "vitest";

import { SyncError, createSyncEngine, scanVault, type VaultPath } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

/** A vault whose read() answers for a file that is no longer there. */
function vanishingAt(vault: MemoryVault, gone: VaultPath, error: SyncError): MemoryVault {
  const realRead = vault.read.bind(vault);
  vault.read = (p: VaultPath) => (p === gone ? Promise.reject(error) : realRead(p));
  return vault;
}

describe("a file that goes between stat() and read()", () => {
  it("is skipped, exactly as one that goes between list() and stat()", async () => {
    const vault = new MemoryVault();
    vault.setFile("keep.md", "still here");
    vault.setFile("gone.md", "not for long");
    vanishingAt(vault, "gone.md", new SyncError("VaultFileNotFound", "not found"));

    const scan = await scanVault(vault, new IdentityCrypto());
    expect(scan.map((f) => f.path)).toEqual(["keep.md"]);
  });

  it("does not leave a stale hash-cache entry behind for it", async () => {
    const vault = new MemoryVault();
    vault.setFile("keep.md", "still here");
    vault.setFile("gone.md", "not for long");
    vanishingAt(vault, "gone.md", new SyncError("VaultFileNotFound", "not found"));

    // A cache entry from an earlier scan, with a (size, mtime) that no longer
    // matches — so the scan tries to re-read, and that is when it vanishes.
    const cache = new Map<VaultPath, { size: number; mtime: number; hash: string }>([
      ["gone.md", { size: 999, mtime: 1, hash: "b3:from-an-older-scan" }],
    ]);
    await scanVault(vault, new IdentityCrypto(), cache);

    // A complete scan prunes what it did not see, and a path it could not read
    // is not one it saw: leaving the entry would hand a later scan a hash for
    // content nobody verified.
    expect([...cache.keys()]).toEqual(["keep.md"]);
  });

  it("a whole sync still completes, and the surviving file is uploaded", async () => {
    const storage = new MemoryStorage();
    const vault = new MemoryVault();
    vault.setFile("keep.md", "still here");
    vault.setFile("gone.md", "not for long");
    vanishingAt(vault, "gone.md", new SyncError("VaultFileNotFound", "not found"));

    const engine = createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock: new FixedClock(),
      log: new MemoryLog(),
      state: new MemoryStateStore(),
      deviceId: "dev-a",
      storagePrefix: "",
    });

    const report = await engine.sync();
    expect(report.outcome).toBe("applied");
    expect(report.entries.map((e) => e.path)).toEqual(["keep.md"]);
  });

  it("A REAL READ FAILURE IS NOT A VANISH AND STILL STOPS THE SCAN", async () => {
    // A permission error, a locked file, a failing disk: the file exists and
    // the answer is about it. Treating that as "gone" would report a local
    // deletion and tombstone it for every device.
    const vault = new MemoryVault();
    vault.setFile("locked.md", "readable by someone else");
    vanishingAt(
      vault,
      "locked.md",
      new SyncError("VaultWriteFailed", "EPERM: operation not permitted"),
    );

    await expect(scanVault(vault, new IdentityCrypto())).rejects.toSatisfy(
      (e) => e instanceof SyncError && e.code === "VaultWriteFailed",
    );
  });

  it("a file read from the hash cache is never read at all", async () => {
    const vault = new MemoryVault();
    vault.setFile("cached.md", "hello");
    const first = await scanVault(vault, new IdentityCrypto(), new Map());
    const entry = first[0];
    expect(entry).toBeDefined();

    const cache = new Map([
      [
        "cached.md",
        { size: entry?.size ?? 0, mtime: entry?.mtime ?? 0, hash: entry?.hash ?? "" },
      ],
    ]);
    vanishingAt(vault, "cached.md", new SyncError("VaultFileNotFound", "not found"));

    const second = await scanVault(vault, new IdentityCrypto(), cache);
    expect(second.map((f) => f.path)).toEqual(["cached.md"]);
  });
});
