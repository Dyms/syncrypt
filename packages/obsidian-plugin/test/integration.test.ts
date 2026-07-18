// Headless integration: the REAL engine + REAL crypto running over the
// ObsidianVault adapter and AdapterStateStore — exactly the plugin's wiring,
// minus the Obsidian UI. Two mock vaults converge; trash catches deletions;
// a restart resumes from persisted state (ADR-0011).

import { describe, expect, it } from "vitest";

import { openSyncEngine } from "@syncrypt/sdk";
import { MemoryStorage } from "@syncrypt/core/testing";
import { FixedClock } from "@syncrypt/core/testing";

import { DEFAULT_PROFILE } from "../src/profile.js";
import { AdapterStateStore } from "../src/state-store.js";
import { ObsidianVault, SYNC_TRASH_DIR } from "../src/vault-adapter.js";
import { MockDataAdapter } from "./mock-adapter.js";

const PASSPHRASE = "plugin integration passphrase";
const KDF_TEST_PRESET = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const;

async function makeDevice(storage: MemoryStorage, id: string, adapter: MockDataAdapter) {
  adapter.folders.add(".obsidian");
  const clock = new FixedClock();
  const engine = await openSyncEngine({
    storage,
    vault: new ObsidianVault(adapter, DEFAULT_PROFILE),
    passphrase: PASSPHRASE,
    deviceId: id,
    state: new AdapterStateStore(adapter),
    clock,
    kdfDefaults: KDF_TEST_PRESET,
  });
  return { engine, adapter, clock };
}

describe("plugin wiring end-to-end (mock Obsidian adapter)", () => {
  it("two vaults converge; deletions land in sync-trash; state survives restart", async () => {
    const storage = new MemoryStorage();
    const a = await makeDevice(storage, "dev-a", new MockDataAdapter());
    const b = await makeDevice(storage, "dev-b", new MockDataAdapter());

    a.adapter.setFile("note.md", "hello from a");
    a.adapter.setFile("dir/deep.md", "nested");
    expect((await a.engine.sync()).outcome).toBe("applied");
    expect((await b.engine.sync()).outcome).toBe("applied");
    expect(b.adapter.getText("note.md")).toBe("hello from a");
    expect(b.adapter.getText("dir/deep.md")).toBe("nested");

    // Deletion propagates through the tombstone into b's SYNC-TRASH.
    await a.adapter.remove("dir/deep.md");
    a.clock.advance(60);
    a.adapter.now = a.clock.now() * 1000;
    await a.engine.sync();
    await b.engine.sync();
    expect(b.adapter.getText("dir/deep.md")).toBeNull();
    expect(b.adapter.getText(`${SYNC_TRASH_DIR}/dir/deep.md`)).toBe("nested");

    // The trash itself never syncs back to a.
    await a.engine.sync();
    expect(a.adapter.getText(`${SYNC_TRASH_DIR}/dir/deep.md`)).toBeNull();

    // "Restart" device b: same adapter (state file persisted), fresh engine.
    const b2 = await makeDevice(storage, "dev-b", b.adapter);
    const status = await b2.engine.status();
    expect(status.baseGeneration).toBeGreaterThanOrEqual(2); // resumed, no reconcile
    expect((await b2.engine.sync()).outcome).toBe("no-op");

    // Storage holds only ciphertext (spot check).
    for (const key of storage.keys()) {
      if (key.endsWith("keyfile-params.json")) continue;
      const head = new TextDecoder().decode((await storage.get(key)).subarray(0, 4));
      expect(head, key).toBe("SYNC");
    }
  });

  it("conflict: both edited → conflicted copy appears in both mock vaults", async () => {
    const storage = new MemoryStorage();
    const a = await makeDevice(storage, "dev-a", new MockDataAdapter());
    const b = await makeDevice(storage, "dev-b", new MockDataAdapter());
    a.adapter.setFile("note.md", "base");
    await a.engine.sync();
    await b.engine.sync();

    a.adapter.now += 1000;
    a.adapter.setFile("note.md", "version A");
    await a.engine.sync();
    b.adapter.now += 2000;
    b.adapter.setFile("note.md", "version B");
    const report = await b.engine.sync();
    expect(report.conflicts).toEqual(["note.md"]);
    await a.engine.sync();

    const copies = [...b.adapter.files.keys()].filter((k) => k.includes("conflicted copy"));
    expect(copies).toHaveLength(1);
    expect(b.adapter.getText("note.md")).toBe("version B");
    expect(a.adapter.getText("note.md")).toBe("version B");
    expect(a.adapter.getText(copies[0] ?? "")).toBe("version A");
  });
});
