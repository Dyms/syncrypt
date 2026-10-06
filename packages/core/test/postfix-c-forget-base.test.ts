// POST-FIX REVIEW (slice C): forgetPaths/releaseForgotten adopt the REMOTE
// manifest as this device's base, for paths this device never pulled.
import { describe, expect, it } from "vitest";

import { createSyncEngine, type VaultPath } from "../src/index.js";
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
  syncable(path: VaultPath): boolean {
    return this.carries(path);
  }
}

function dev(storage: MemoryStorage, id: string, vault: MemoryVault) {
  return createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock: new FixedClock(),
    log: new MemoryLog(),
    state: new MemoryStateStore(),
    deviceId: id,
    storagePrefix: "",
  });
}

const text = async (v: MemoryVault, p: string): Promise<string> =>
  new TextDecoder().decode(await v.read(p));

describe("forget on a device that is behind", () => {
  it("does not turn another device's edit into a stale local 'edit' that overwrites it", async () => {
    const storage = new MemoryStorage();
    const aVault = new MemoryVault();
    const a = dev(storage, "desktop", aVault);
    aVault.setFile("note.md", "v1");
    aVault.setFile("papers/big.pdf", "PDF");
    await a.sync();

    const bVault = new ProfiledVault((p) => !p.endsWith(".pdf"));
    const b = dev(storage, "phone", bVault);
    await b.sync();
    expect(await text(bVault, "note.md")).toBe("v1");

    // Desktop edits; phone has not pulled yet.
    aVault.setFile("note.md", "v2-desktop-edit");
    await a.sync();

    // Phone forgets the PDF it does not carry (Settings → uncarried entries).
    const r = await b.forgetPaths(["papers/big.pdf"]);
    expect(r.forgotten).toEqual(["papers/big.pdf"]);

    // Phone's next sync must bring v2, not push v1 over it.
    await b.sync();
    await a.sync();
    expect(await text(aVault, "note.md")).toBe("v2-desktop-edit");
    expect(await text(bVault, "note.md")).toBe("v2-desktop-edit");
  });
});

describe("release on a device that is behind", () => {
  it("does not turn another device's edit into a stale local 'edit' that overwrites it", async () => {
    const storage = new MemoryStorage();
    const aVault = new MemoryVault();
    const a = dev(storage, "desktop", aVault);
    aVault.setFile("note.md", "v1");
    aVault.setFile("papers/big.pdf", "PDF");
    await a.sync();
    // Desktop forgets the PDF entry (kept copy), so there is something to release.
    const bVault = new MemoryVault();
    const b = dev(storage, "phone", bVault);
    await b.sync();
    await a.forgetPaths(["papers/big.pdf"]);
    await a.sync();
    await b.sync();

    aVault.setFile("note.md", "v2-desktop-edit");
    await a.sync();

    // The phone, not yet pulled, releases the kept copies.
    const r = await b.releaseForgotten();
    expect(r.released).toBeGreaterThan(0);
    await b.sync();
    await a.sync();
    expect(await text(aVault, "note.md")).toBe("v2-desktop-edit");
  });
});
