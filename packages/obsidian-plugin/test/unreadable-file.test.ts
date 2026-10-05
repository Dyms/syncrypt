// ADR-0062: a file that exists but cannot be read right now is not a deleted
// file. It used to be — ObsidianVault.read() answered "not found" for every
// failure, the scan took that as a vanish, and the push published a tombstone
// that sent the file to the trash on every other device. OneDrive's
// Files-On-Demand placeholder without a network, a permission, a lock held by
// another program: all of them are "there, unreadable", never "gone".

import { describe, expect, it } from "vitest";

import { openSyncEngine } from "@syncrypt/sdk";
import { FixedClock, MemoryLog, MemoryStorage } from "@syncrypt/core/testing";

import { DEFAULT_PROFILE } from "../src/profile.js";
import { AdapterStateStore } from "../src/state-store.js";
import { DEFAULT_SYNC_TRASH_DIR, ObsidianVault } from "../src/vault-adapter.js";
import { MockDataAdapter } from "./mock-adapter.js";

const KDF_TEST_PRESET = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const;

/** A file that is on disk and refuses to be read, the way a held lock does. */
class LockingAdapter extends MockDataAdapter {
  readonly locked = new Set<string>();
  override async readBinary(path: string): Promise<ArrayBuffer> {
    if (this.locked.has(path)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${path}'`), {
        code: "EBUSY",
      });
    }
    return super.readBinary(path);
  }
}

async function device(storage: MemoryStorage, id: string, adapter: MockDataAdapter) {
  adapter.folders.add(".obsidian");
  const clock = new FixedClock();
  const log = new MemoryLog();
  const engine = await openSyncEngine({
    storage,
    vault: new ObsidianVault(adapter, DEFAULT_PROFILE),
    passphrase: "unreadable file passphrase",
    deviceId: id,
    state: new AdapterStateStore(adapter),
    clock,
    kdfDefaults: KDF_TEST_PRESET,
    log,
  });
  return { engine, adapter, clock, log };
}

describe("a file that is there but cannot be read (ADR-0062)", () => {
  it("is not tombstoned, does not stop the rest of the vault, and is named", async () => {
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a", new LockingAdapter());
    const b = await device(storage, "dev-b", new MockDataAdapter());
    a.adapter.setFile("budget.xlsx", "numbers");
    a.adapter.setFile("note.md", "hello");
    await a.engine.sync();
    await b.engine.sync();
    expect(b.adapter.getText("budget.xlsx")).toBe("numbers");

    // Saved by another program (new mtime, so the hash cache misses) and held.
    a.clock.advance(60);
    a.adapter.now = a.clock.now() * 1000;
    a.adapter.setFile("budget.xlsx", "numbers v2");
    a.adapter.setFile("note.md", "hello again");
    (a.adapter as LockingAdapter).locked.add("budget.xlsx");

    const held = await a.engine.sync();
    // The rest of the vault is not hostage to one held file...
    expect(held.outcome).toBe("applied");
    expect(held.entries.map((e) => `${e.kind} ${e.path}`)).toEqual(["upload note.md"]);
    // ...and the held one is named, not passed over in silence.
    expect(a.log.notices).toContainEqual({ code: "paths-unreadable", paths: ["budget.xlsx"] });
    await b.engine.sync();
    expect(b.adapter.getText("note.md")).toBe("hello again");
    expect(b.adapter.getText("budget.xlsx")).toBe("numbers");
    expect(b.adapter.getText(`${DEFAULT_SYNC_TRASH_DIR}/budget.xlsx`)).toBeNull();

    // The lock goes; the edit travels as an edit — not a conflict, not a copy.
    (a.adapter as LockingAdapter).locked.clear();
    a.clock.advance(60);
    const released = await a.engine.sync();
    expect(released.entries.map((e) => `${e.kind} ${e.path}`)).toEqual(["upload budget.xlsx"]);
    await b.engine.sync();
    expect(b.adapter.getText("budget.xlsx")).toBe("numbers v2");
    expect(b.adapter.getText(`${DEFAULT_SYNC_TRASH_DIR}/budget.xlsx`)).toBeNull();
  });

  it("a file that really went between list and read is still a vanish, not a failure", async () => {
    // The other half of the rule (ADR-0054 §4): absence stays absence. Without
    // it, any file deleted mid-scan would fail the whole sync.
    class VanishingAdapter extends MockDataAdapter {
      vanish: string | null = null;
      override async readBinary(path: string): Promise<ArrayBuffer> {
        if (path === this.vanish) {
          this.files.delete(path);
          this.vanish = null;
        }
        return super.readBinary(path);
      }
    }
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a", new VanishingAdapter());
    a.adapter.setFile("keep.md", "k");
    a.adapter.setFile("gone.md", "g");
    (a.adapter as VanishingAdapter).vanish = "gone.md";
    const report = await a.engine.sync();
    expect(report.outcome).toBe("applied");
    expect(report.entries.map((e) => e.path)).toEqual(["keep.md"]);
  });
});

describe("a remote edit to a file that is unreadable here", () => {
  it("is not written over it this run, and lands once the file is readable", async () => {
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a", new MockDataAdapter());
    const b = await device(storage, "dev-b", new LockingAdapter());
    a.adapter.setFile("budget.xlsx", "numbers");
    await a.engine.sync();
    await b.engine.sync();

    a.clock.advance(60);
    a.adapter.now = a.clock.now() * 1000;
    a.adapter.setFile("budget.xlsx", "numbers from A");
    await a.engine.sync();

    (b.adapter as LockingAdapter).locked.add("budget.xlsx");
    b.adapter.now += 60_000;
    b.adapter.setFile("budget.xlsx", "numbers from B, still open");
    const held = await b.engine.sync();
    expect(held.entries.filter((e) => e.path === "budget.xlsx")).toEqual([]);
    expect(b.adapter.getText("budget.xlsx")).toBe("numbers from B, still open");

    (b.adapter as LockingAdapter).locked.clear();
    await b.engine.sync();
    // Both sides changed it: a conflict, both versions kept.
    const texts = [...b.adapter.files.values()].map((f) => new TextDecoder().decode(f.data));
    expect(texts).toContain("numbers from A");
    expect(texts).toContain("numbers from B, still open");
  });
});

describe("a path this device never synced, held on its first sync", () => {
  it("does not inherit the other device's version as base, so it cannot overwrite it", async () => {
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a", new MockDataAdapter());
    a.adapter.setFile("budget.xlsx", "A's budget");
    await a.engine.sync();

    // A new device whose vault already has its own budget.xlsx, held open.
    const b = await device(storage, "dev-b", new LockingAdapter());
    b.adapter.setFile("budget.xlsx", "B's budget, a different file");
    (b.adapter as LockingAdapter).locked.add("budget.xlsx");
    await b.engine.sync();

    (b.adapter as LockingAdapter).locked.clear();
    await b.engine.sync();
    await a.engine.sync();

    // Two independent files on one path: a conflict, both kept — on both sides.
    for (const side of [a, b]) {
      const texts = [...side.adapter.files.values()].map((f) => new TextDecoder().decode(f.data));
      expect(texts).toContain("A's budget");
      expect(texts).toContain("B's budget, a different file");
    }
  });
});
