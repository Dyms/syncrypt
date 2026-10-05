// ADR-0070: the release dialog names what the storage holds, and release acts
// on exactly that. Audit №4 (B5): the plugin showed this device's base count
// (1) and releaseForgotten released the storage's set (4) — three copies that
// another device forgot, any of which may be the last one, let go unseen.

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
  constructor(private readonly carries: (p: VaultPath) => boolean) {
    super();
  }
  override async *list(): AsyncIterable<VaultPath> {
    for await (const p of super.list()) if (this.carries(p)) yield p;
  }
  syncable(p: VaultPath): boolean {
    return this.carries(p);
  }
}

function device(storage: MemoryStorage, id: string, vault: MemoryVault): SyncEngine {
  return createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock: new FixedClock(1_000_000),
    log: new MemoryLog(),
    state: new MemoryStateStore(),
    deviceId: id,
    storagePrefix: "",
  });
}

const manifests = (s: MemoryStorage): number =>
  s.keys().filter((k) => k.startsWith("manifests/")).length;

/** Phone A forgot one PDF; phone B, later, three more. A has not synced since. */
async function twoForgetters() {
  const storage = new MemoryStorage();
  const laptopVault = new MemoryVault();
  for (const n of ["a", "bb", "ccc", "dddd"]) laptopVault.setFile(`${n}.pdf`, `only copy ${n}`);
  laptopVault.setFile("note.md", "kept");
  await device(storage, "laptop", laptopVault).sync();

  const noPdf = (p: VaultPath): boolean => !p.endsWith(".pdf");
  const a = device(storage, "phone-a", new ProfiledVault(noPdf));
  const b = device(storage, "phone-b", new ProfiledVault(noPdf));
  await a.sync();
  await a.forgetPaths(["a.pdf"]);
  await b.sync();
  await b.forgetPaths(["bb.pdf", "ccc.pdf", "dddd.pdf"]);
  return { storage, a };
}

describe("release names and acts on the storage's set (ADR-0070)", () => {
  it("the preview reads the storage, not this device's base", async () => {
    const { a } = await twoForgetters();
    expect((await a.status()).forgottenObjects).toBe(1); // what the dialog used to say
    expect(await a.previewRelease()).toHaveLength(4);
  });

  it("releasing a set other than the one shown publishes nothing", async () => {
    const { storage, a } = await twoForgetters();
    const before = manifests(storage);
    const shownOnce = (await a.previewRelease()).slice(0, 1);
    const result = await a.releaseForgotten(undefined, shownOnce);
    expect(result).toEqual({ released: 0, generation: null, stale: true });
    expect(manifests(storage)).toBe(before);
    expect(await a.previewRelease()).toHaveLength(4);
  });

  it("releasing exactly what was shown releases it, in any order", async () => {
    const { a } = await twoForgetters();
    const shown = (await a.previewRelease()).reverse();
    const result = await a.releaseForgotten(undefined, shown);
    expect(result.released).toBe(4);
    expect(result.generation).not.toBeNull();
    expect(await a.previewRelease()).toEqual([]);
  });

  it("a superset is as stale as a subset", async () => {
    const { a } = await twoForgetters();
    const shown = [...(await a.previewRelease()), "objects/not-kept"];
    expect((await a.releaseForgotten(undefined, shown)).stale).toBe(true);
  });

  it("without an expected set the SDK releases as before", async () => {
    const { a } = await twoForgetters();
    expect((await a.releaseForgotten()).released).toBe(4);
  });

  it("a storage that went backwards previews nothing (ADR-0041's door)", async () => {
    const { storage, a } = await twoForgetters();
    await a.sync(); // A's base is the top generation now
    const top = storage
      .keys()
      .filter((k) => k.startsWith("manifests/"))
      .sort()
      .at(-1);
    if (top === undefined) throw new Error("no manifest");
    await storage.delete(top); // a restore from an older backup
    expect(await a.previewRelease()).toEqual([]);
  });

  it("an empty storage previews nothing", async () => {
    const e = device(new MemoryStorage(), "x", new MemoryVault());
    expect(await e.previewRelease()).toEqual([]);
  });

  it("a cancelled preview is not an empty one", async () => {
    const { a } = await twoForgetters();
    const ctl = new AbortController();
    ctl.abort();
    await expect(a.previewRelease(ctl.signal)).rejects.toMatchObject({ code: "Aborted" });
  });
});
