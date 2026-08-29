// Forgetting a manifest entry is not deleting a file — ADR-0027.
//
// The whole design rests on one property of RFC-0004: an entry that vanishes
// from the manifest without a tombstone is an ANOMALY to repair, not a
// deletion to propagate. So a device that still carries the path puts it back.
// If that ever stopped being true, this operation would become a data-loss
// button, so it is pinned down here first.

import { describe, expect, it } from "vitest";

import { createSyncEngine, type SyncEngine, type VaultPath } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

class ProfiledVault extends MemoryVault {
  constructor(public carries: (path: VaultPath) => boolean) {
    super();
  }
  override async *list(): AsyncIterable<VaultPath> {
    for await (const path of super.list()) if (this.carries(path)) yield path;
  }
  // Not an override: MemoryVault has no profile — VaultPort.syncable is optional.
  syncable(path: VaultPath): boolean {
    return this.carries(path);
  }
}

interface Device {
  engine: SyncEngine;
  vault: MemoryVault;
  log: MemoryLog;
}

function makeDevice(
  storage: MemoryStorage,
  deviceId: string,
  vault: MemoryVault,
  state = new MemoryStateStore(),
): Device {
  const log = new MemoryLog();
  return {
    engine: createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock: new FixedClock(),
      log,
      state,
      deviceId,
      storagePrefix: "",
    }),
    vault,
    log,
  };
}

describe("listUncarried", () => {
  it("lists what this device's profile does not cover, and nothing else", async () => {
    const storage = new MemoryStorage();
    const desktop = makeDevice(storage, "desktop", new MemoryVault());
    desktop.vault.setFile("note.md", "hello");
    desktop.vault.setFile("papers/big.pdf", "PDF");
    desktop.vault.setFile("papers/old.pdf", "OLD");
    await desktop.engine.sync();

    const phone = makeDevice(storage, "phone", new ProfiledVault((p) => !p.endsWith(".pdf")));
    await phone.engine.sync();

    const candidates = await phone.engine.listUncarried();
    expect(candidates.map((c) => c.path)).toEqual(["papers/big.pdf", "papers/old.pdf"]);
    // Enough to recognize a file without downloading it.
    expect(candidates[0]?.size).toBe(3);
    expect(candidates[0]?.hash).not.toBe("");

    // The desktop carries everything, so it has nothing to review.
    expect(await desktop.engine.listUncarried()).toEqual([]);
  });

  it("reads only — nothing is published", async () => {
    const storage = new MemoryStorage();
    const desktop = makeDevice(storage, "desktop", new MemoryVault());
    desktop.vault.setFile("papers/big.pdf", "PDF");
    await desktop.engine.sync();
    const before = storage.keys();
    const phone = makeDevice(storage, "phone", new ProfiledVault(() => false));
    await phone.engine.listUncarried();
    expect(storage.keys()).toEqual(before);
  });
});

describe("forgetPaths", () => {
  it("SAFETY: a device that still carries the path puts it straight back", async () => {
    const storage = new MemoryStorage();
    const desktopState = new MemoryStateStore();
    const desktop = makeDevice(storage, "desktop", new MemoryVault(), desktopState);
    desktop.vault.setFile("note.md", "hello");
    desktop.vault.setFile("papers/big.pdf", "PDF BYTES");
    await desktop.engine.sync();

    const phone = makeDevice(storage, "phone", new ProfiledVault((p) => !p.endsWith(".pdf")));
    await phone.engine.sync();

    // The phone wrongly decides nobody carries the PDF.
    const result = await phone.engine.forgetPaths(["papers/big.pdf"]);
    expect(result.forgotten).toEqual(["papers/big.pdf"]);
    expect(result.generation).not.toBeNull();

    // The desktop's file is untouched, never trashed, and the entry returns.
    await desktop.engine.sync();
    expect(desktop.vault.getText("papers/big.pdf")).toBe("PDF BYTES");
    expect(desktop.vault.trashed).toEqual([]);
    expect((await phone.engine.listUncarried()).map((c) => c.path)).toEqual(["papers/big.pdf"]);
  });

  it("a genuine orphan stays gone", async () => {
    const storage = new MemoryStorage();
    const desktop = makeDevice(storage, "desktop", new MemoryVault());
    desktop.vault.setFile("note.md", "hello");
    desktop.vault.setFile("gone.md", "nobody carries me");
    await desktop.engine.sync();

    // The only device that had it narrows its profile: now nobody carries it.
    const narrowed = makeDevice(
      storage,
      "desktop",
      new ProfiledVault((p) => p !== "gone.md"),
    );
    narrowed.vault.setFile("note.md", "hello");
    await narrowed.engine.sync();

    expect((await narrowed.engine.listUncarried()).map((c) => c.path)).toEqual(["gone.md"]);
    await narrowed.engine.forgetPaths(["gone.md"]);
    await narrowed.engine.sync();
    expect(await narrowed.engine.listUncarried()).toEqual([]);
  });

  it("writes no tombstone — forgetting must never look like a deletion", async () => {
    const storage = new MemoryStorage();
    const desktop = makeDevice(storage, "desktop", new MemoryVault());
    desktop.vault.setFile("papers/big.pdf", "PDF");
    await desktop.engine.sync();
    const phone = makeDevice(storage, "phone", new ProfiledVault(() => false));
    await phone.engine.sync();
    await phone.engine.forgetPaths(["papers/big.pdf"]);

    // Read the published manifest back: no tombstone anywhere for that path.
    const keys = storage.keys().filter((k) => k.startsWith("manifests/"));
    const newest = keys[keys.length - 1] ?? "";
    const body = new TextDecoder().decode(await storage.get(newest));
    expect(body).toContain("tombstones");
    expect(JSON.parse(body.slice(body.indexOf("{"))) as { tombstones: object }).toHaveProperty(
      "tombstones",
      {},
    );
  });

  it("an unknown or empty path list does nothing at all", async () => {
    const storage = new MemoryStorage();
    const desktop = makeDevice(storage, "desktop", new MemoryVault());
    desktop.vault.setFile("note.md", "hello");
    await desktop.engine.sync();
    const before = storage.keys();

    expect(await desktop.engine.forgetPaths([])).toEqual({ forgotten: [], generation: null });
    expect(await desktop.engine.forgetPaths(["never-existed.md"])).toEqual({
      forgotten: [],
      generation: null,
    });
    expect(storage.keys()).toEqual(before); // no generation burned
  });

  it("reports what it did as a code, not a sentence (ADR-0026)", async () => {
    const storage = new MemoryStorage();
    const desktop = makeDevice(storage, "desktop", new MemoryVault());
    desktop.vault.setFile("papers/big.pdf", "PDF");
    await desktop.engine.sync();
    const phone = makeDevice(storage, "phone", new ProfiledVault(() => false));
    await phone.engine.sync();
    await phone.engine.forgetPaths(["papers/big.pdf"]);
    expect(phone.log.noticed("manifest-entries-forgotten")).toBe(true);
  });
});
