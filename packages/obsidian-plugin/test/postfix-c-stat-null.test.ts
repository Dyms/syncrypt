// POST-FIX REVIEW (slice C): ADR-0062 makes read() say "not found" only when
// exists() confirms it. stat() makes the SAME claim with null — the scan's
// `if (stat === null) continue; // vanished mid-scan` drops a LISTED file, and
// the planner tombstones it for every device — and ObsidianVault.stat()
// returns null for whatever adapter.stat() answers null, without asking.
// Modelled: an adapter whose stat() answers null on an error instead of
// rejecting (the shape of an adapter that catches and returns null — which
// adapter does this on a real device is NOT verified here).
import { describe, expect, it } from "vitest";

import { openSyncEngine } from "@syncrypt/sdk";
import { FixedClock, MemoryLog, MemoryStorage } from "@syncrypt/core/testing";

import type { AdapterStat } from "../src/adapter-types.js";
import { DEFAULT_PROFILE } from "../src/profile.js";
import { AdapterStateStore } from "../src/state-store.js";
import { DEFAULT_SYNC_TRASH_DIR, ObsidianVault } from "../src/vault-adapter.js";
import { MockDataAdapter } from "./mock-adapter.js";

const KDF = { kdf: "argon2id", version: 1, memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

class SwallowingStat extends MockDataAdapter {
  readonly failing = new Set<string>();
  override async stat(path: string): Promise<AdapterStat | null> {
    if (this.failing.has(path)) return null; // EACCES / SAF error swallowed
    return super.stat(path);
  }
}

async function device(storage: MemoryStorage, id: string, adapter: MockDataAdapter) {
  adapter.folders.add(".obsidian");
  const engine = await openSyncEngine({
    storage,
    vault: new ObsidianVault(adapter, DEFAULT_PROFILE),
    passphrase: "stat null passphrase",
    deviceId: id,
    state: new AdapterStateStore(adapter),
    clock: new FixedClock(),
    kdfDefaults: KDF,
    log: new MemoryLog(),
  });
  return { engine, adapter };
}

describe("a listed file whose stat fails is not a deleted file", () => {
  it("a stat that throws fails the sync too", async () => {
    class ThrowingStat extends MockDataAdapter {
      fail = false;
      override async stat(path: string): Promise<AdapterStat | null> {
        if (this.fail && path === "n.md") throw new Error("EIO");
        return super.stat(path);
      }
    }
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a", new ThrowingStat());
    a.adapter.setFile("n.md", "x");
    await a.engine.sync();
    (a.adapter as ThrowingStat).fail = true;
    await expect(a.engine.sync()).rejects.toMatchObject({ code: "VaultWriteFailed" });
  });

  it("a confirmed-absent file is still a deletion", async () => {
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a", new SwallowingStat());
    a.adapter.setFile("gone.md", "x");
    await a.engine.sync();
    a.adapter.files.delete("gone.md");
    const r = await a.engine.sync();
    expect(r.entries.filter((e) => e.kind === "delete-remote").map((e) => e.path)).toEqual(["gone.md"]);
  });

  it("is not tombstoned", async () => {
    const storage = new MemoryStorage();
    const a = await device(storage, "dev-a", new SwallowingStat());
    const b = await device(storage, "dev-b", new MockDataAdapter());
    a.adapter.setFile("budget.xlsx", "numbers");
    await a.engine.sync();
    await b.engine.sync();
    (a.adapter as SwallowingStat).failing.add("budget.xlsx"); // still on disk
    // Same rule as a failed read in the scan (ADR-0062): the sync fails loudly
    // instead of reading "unstat-able" as "deleted" (ADR-0081).
    await expect(a.engine.sync()).rejects.toMatchObject({ code: "VaultWriteFailed" });
    await b.engine.sync();
    expect(b.adapter.getText(`${DEFAULT_SYNC_TRASH_DIR}/budget.xlsx`)).toBeNull();
  });
});
