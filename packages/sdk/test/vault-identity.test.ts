// ADR-0079 through the SDK: openSyncEngine passes the vault's salt as its
// identity, so a state store reused for another vault — what the plugin did
// before ADR-0065, and what any SDK client can still do — does not turn one
// vault's base into the other's common ancestor (audit №4, D3).

import { describe, expect, it } from "vitest";

import {
  FixedClock,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "@syncrypt/core/testing";

import { openSyncEngine } from "../src/index.js";

const PRESET = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const;

function open(opts: {
  storage: MemoryStorage;
  prefix: string;
  vault: MemoryVault;
  state: MemoryStateStore;
  device: string;
  log?: MemoryLog;
  generationsToKeep?: number;
}) {
  return openSyncEngine({
    storage: opts.storage,
    storagePrefix: opts.prefix,
    vault: opts.vault,
    state: opts.state,
    passphrase: "one passphrase for both vaults",
    deviceId: opts.device,
    clock: new FixedClock(),
    kdfDefaults: PRESET,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    ...(opts.generationsToKeep !== undefined
      ? { safeSync: { generationsToKeep: opts.generationsToKeep } }
      : {}),
  });
}

describe("openSyncEngine ties the base to the vault (ADR-0079)", () => {
  it("one state store, two vaults: the local note survives", async () => {
    const storage = new MemoryStorage();
    const other = new MemoryVault();
    const e = await open({
      storage,
      prefix: "vault-b",
      vault: other,
      state: new MemoryStateStore(),
      device: "dev-e",
      generationsToKeep: 2,
    });
    other.setFile("Inbox.md", "B's inbox");
    for (let i = 0; i < 6; i++) {
      other.setFile(`b${String(i)}.md`, `b ${String(i)}`);
      await e.sync();
    }
    await e.reclaimStorage();

    const state = new MemoryStateStore();
    const local = new MemoryVault();
    const a = await open({ storage, prefix: "vault-a", vault: local, state, device: "dev-d" });
    local.setFile("Inbox.md", "A's inbox, written here");
    await a.sync();
    for (let i = 0; i < 2; i++) {
      local.setFile(`a${String(i)}.md`, `a ${String(i)}`);
      await a.sync();
    }

    const log = new MemoryLog();
    const b = await open({ storage, prefix: "vault-b", vault: local, state, device: "dev-d", log });
    await b.sync();
    expect(new TextDecoder().decode(await local.read("Inbox.md"))).toBe("A's inbox, written here");
    expect(log.notices.map((n) => n.code)).toContain("base-other-vault");
  });

  it("the same vault, reopened, keeps its base", async () => {
    const storage = new MemoryStorage();
    const state = new MemoryStateStore();
    const vault = new MemoryVault();
    const first = await open({ storage, prefix: "v", vault, state, device: "dev-d" });
    vault.setFile("a.md", "a");
    await first.sync();
    const log = new MemoryLog();
    const again = await open({ storage, prefix: "v", vault, state, device: "dev-d", log });
    expect((await again.status()).baseGeneration).not.toBeNull();
    expect(log.notices.map((n) => n.code)).not.toContain("base-other-vault");
  });
});
