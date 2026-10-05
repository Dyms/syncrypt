// ADR-0077: ObsidianVault reaches a file by its spelling on this disk.
// MockDataAdapter is a plain Map — a filesystem that keeps the bytes it is
// given, like ext4 on Linux and Android. Audit №4 (C2): a file named in NFD
// was listed as NFC and then not found under that name: never synced, and if
// it had been, tombstoned for every device.

import { describe, expect, it } from "vitest";

import { openSyncEngine } from "@syncrypt/sdk";
import { FixedClock, MemoryStorage } from "@syncrypt/core/testing";

import { DEFAULT_PROFILE } from "../src/profile.js";
import { AdapterStateStore } from "../src/state-store.js";
import { DEFAULT_SYNC_TRASH_DIR, ObsidianVault } from "../src/vault-adapter.js";
import { MockDataAdapter } from "./mock-adapter.js";

const NFC = "café";
const NFD = "café";
const KDF = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const;

async function device(storage: MemoryStorage, id: string) {
  const adapter = new MockDataAdapter();
  adapter.folders.add(".obsidian");
  const clock = new FixedClock();
  const engine = await openSyncEngine({
    storage,
    vault: new ObsidianVault(adapter, DEFAULT_PROFILE),
    passphrase: "native spelling",
    deviceId: id,
    state: new AdapterStateStore(adapter),
    clock,
    kdfDefaults: KDF,
  });
  const tick = (): void => {
    clock.advance(60);
    adapter.now = clock.now() * 1000;
  };
  return { engine, adapter, tick };
}

describe("a name spelled in NFD on a byte-preserving disk (ADR-0077)", () => {
  it("is synced", async () => {
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a");
    const b = await device(storage, "dev-b");
    a.adapter.setFile(`${NFD}.md`, "bonjour"); // copied from a Mac by rsync
    await a.engine.sync();
    await b.engine.sync();
    expect(b.adapter.getText(`${NFC}.md`)).toBe("bonjour");
  });

  it("a synced file whose disk spelling became NFD is not tombstoned", async () => {
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a");
    const b = await device(storage, "dev-b");
    a.adapter.setFile(`${NFC}.md`, "bonjour");
    await a.engine.sync();
    await b.engine.sync();
    a.tick();
    await a.adapter.remove(`${NFC}.md`);
    a.adapter.setFile(`${NFD}.md`, "bonjour"); // restored from a Mac backup
    const ra = await a.engine.sync();
    expect(ra.entries.filter((e) => e.kind === "delete-remote")).toEqual([]);
    await b.engine.sync();
    expect(b.adapter.getText(`${NFC}.md`)).toBe("bonjour");
    expect(b.adapter.getText(`${DEFAULT_SYNC_TRASH_DIR}/${NFC}.md`)).toBeNull();
  });

  it("an edit to it from elsewhere lands in it, not beside it", async () => {
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a");
    const b = await device(storage, "dev-b");
    a.adapter.setFile(`${NFD}.md`, "v1");
    await a.engine.sync();
    await b.engine.sync();
    b.tick();
    b.adapter.setFile(`${NFC}.md`, "v2 from b");
    await b.engine.sync();
    await a.engine.sync();
    expect(a.adapter.getText(`${NFD}.md`)).toBe("v2 from b");
    expect(a.adapter.getText(`${NFC}.md`)).toBeNull(); // no second spelling
  });

  it("a new file goes into the folder that exists, in its spelling", async () => {
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a");
    const b = await device(storage, "dev-b");
    a.adapter.folders.add(NFD);
    a.adapter.setFile(`${NFD}/old.md`, "old");
    await a.engine.sync();
    await b.engine.sync();
    b.tick();
    b.adapter.setFile(`${NFC}/new.md`, "new");
    await b.engine.sync();
    await a.engine.sync();
    expect(a.adapter.getText(`${NFD}/new.md`)).toBe("new");
    expect([...a.adapter.folders].filter((f) => f === NFC)).toEqual([]);
  });

  it("both spellings at once stay ADR-0053's collision: none synced, none lost", async () => {
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a");
    const b = await device(storage, "dev-b");
    a.adapter.setFile(`${NFC}.md`, "composed");
    a.adapter.setFile(`${NFD}.md`, "decomposed");
    a.adapter.setFile("other.md", "x");
    await a.engine.sync();
    await b.engine.sync();
    expect(b.adapter.getText("other.md")).toBe("x");
    expect(b.adapter.getText(`${NFC}.md`)).toBeNull();
    expect(a.adapter.getText(`${NFC}.md`)).toBe("composed");
    expect(a.adapter.getText(`${NFD}.md`)).toBe("decomposed");
  });

  it("for a collision the adapter does not guess a spelling", async () => {
    // A real directory listing comes in no promised order; this one lists the
    // composed spelling first, so "the last one seen" would be the decomposed.
    class Reversed extends MockDataAdapter {
      override async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        const r = await super.list(path);
        return { files: [...r.files].reverse(), folders: [...r.folders].reverse() };
      }
    }
    const adapter = new Reversed();
    adapter.setFile(`${NFC}.md`, "composed");
    adapter.setFile(`${NFD}.md`, "decomposed");
    adapter.setFile(`${NFD}x.md`, "only decomposed");
    const vault = new ObsidianVault(adapter, DEFAULT_PROFILE);
    for await (const _ of vault.list()) void _;
    expect(vault.toNative(`${NFC}.md`)).toBe(`${NFC}.md`); // the canonical, not either one
    expect(vault.toNative(`${NFC}x.md`)).toBe(`${NFD}x.md`);
  });
});
