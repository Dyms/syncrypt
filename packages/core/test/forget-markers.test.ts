// ADR-0082: a forgotten entry leaves a marker (path → generation). A device
// whose base predates it does not vouch for that path any more, so an
// unrelated file later created there is a conflict, not an edit of its copy —
// also after the copies were released, when the forgotten key list is gone.
import { describe, expect, it } from "vitest";

import { createSyncEngine, parseManifest, type VaultPath } from "../src/index.js";
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

const texts = (...vaults: MemoryVault[]): string[] =>
  vaults.flatMap((v) => [
    ...v.paths().map((p) => v.getText(p) ?? ""),
    ...v.trashed.map((t) => new TextDecoder().decode(t.data)),
  ]);

const encode = (m: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(m));
const base = { version: 1, generation: 3, device: "dev-a", updatedAt: 1_000_000, files: {}, tombstones: {} };

describe("forget markers (ADR-0082)", () => {
  it("survive a release: the carrier keeps its copy when an unrelated file appears", async () => {
    const storage = new MemoryStorage();
    const deskVault = new MemoryVault();
    const desk = dev(storage, "desk", deskVault);
    deskVault.setFile("scan.pdf", "desk's scan");
    await desk.sync();

    const phone = dev(storage, "phone", new ProfiledVault((p) => !p.endsWith(".pdf")));
    await phone.sync();
    await phone.forgetPaths((await phone.listUncarried()).map((u) => u.path));
    expect((await phone.releaseForgotten()).released).toBe(1); // the key list is gone now

    const laptopVault = new MemoryVault();
    const laptop = dev(storage, "laptop", laptopVault);
    laptopVault.setFile("scan.pdf", "laptop's different scan, longer");
    await laptop.sync();

    await desk.sync();
    expect(texts(deskVault, laptopVault)).toContain("desk's scan");
    expect(texts(deskVault, laptopVault)).toContain("laptop's different scan, longer");
  });

  it("a carrier with nothing new at the path re-adds its copy (ADR-0027)", async () => {
    const storage = new MemoryStorage();
    const deskVault = new MemoryVault();
    const desk = dev(storage, "desk", deskVault);
    deskVault.setFile("scan.pdf", "desk's scan");
    await desk.sync();
    const phone = dev(storage, "phone", new ProfiledVault((p) => !p.endsWith(".pdf")));
    await phone.sync();
    await phone.forgetPaths(["scan.pdf"]);
    await phone.releaseForgotten();
    const r = await desk.sync();
    expect(r.entries.map((e) => `${e.kind} ${e.path}`)).toEqual(["upload scan.pdf"]);
  });

  it("are carried through ordinary pushes and through a release", async () => {
    const storage = new MemoryStorage();
    const aVault = new MemoryVault();
    const a = dev(storage, "dev-a", aVault);
    aVault.setFile("x.md", "x");
    aVault.setFile("y.md", "y");
    await a.sync();
    const forgot = await a.forgetPaths(["x.md"]);
    aVault.now += 10;
    aVault.setFile("y.md", "y, edited");
    await a.sync();
    await a.releaseForgotten();
    aVault.now += 10;
    aVault.setFile("y.md", "y, edited again");
    await a.sync();
    const keys = storage.keys().filter((k) => k.includes("manifests/")).sort();
    const newest = parseManifest(await storage.get(keys.at(-1) ?? ""));
    expect(newest.forgottenPaths).toEqual({ "x.md": forgot.generation });
  });

  it("parse: kept when valid, refused when not", () => {
    const ok = parseManifest(encode({ ...base, forgottenPaths: { "a/b.md": 2 } }));
    expect(ok.forgottenPaths).toEqual({ "a/b.md": 2 });
    expect(parseManifest(encode(base)).forgottenPaths).toBeUndefined();
    for (const bad of [[], { "a.md": 0 }, { "a.md": 1.5 }, { "a.md": "2" }, { "../a.md": 2 }]) {
      expect(() => parseManifest(encode({ ...base, forgottenPaths: bad }))).toThrow(/forgottenPaths|non-canonical/);
    }
  });

  it("a carried path forgotten and re-added does not make every later edit a conflict", async () => {
    // Fuzz counterexample: the re-added entry carries the forgotten object key;
    // treating that key as "forgotten" dropped the base entry on every sync.
    const storage = new MemoryStorage();
    const aVault = new MemoryVault();
    const bVault = new MemoryVault();
    const a = dev(storage, "dev-a", aVault);
    const b = dev(storage, "dev-b", bVault);
    bVault.setFile("c.md", "from b");
    aVault.setFile("c.md", "from a, longer");
    await b.sync();
    await a.sync(); // conflict: both kept
    await a.forgetPaths(["c.md"]);
    await a.push(); // a carries it: re-added
    for (let round = 0; round < 3; round++) {
      await b.sync();
      await a.sync();
    }
    const outcomes = [(await a.sync()).outcome, (await b.sync()).outcome];
    expect(outcomes).toEqual(["no-op", "no-op"]);
    expect(aVault.paths().sort()).toEqual(bVault.paths().sort());
  });
});
