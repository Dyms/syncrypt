// ADR-0079: a base is tied to the vault it came from. Audit №4 (D3, B1): one
// state store handed two vaults made vault A's last-synced state the "common
// ancestor" of vault B, and the planner downloaded B's Inbox.md over an
// unchanged local Inbox.md — no trash, no copy. ADR-0065 fixed the plugin by
// keeping one state file per storage location; this holds for any client.

import { describe, expect, it } from "vitest";

import { createSyncEngine, type SyncEngine } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

const DAY = 24 * 60 * 60;

function engine(opts: {
  storage: MemoryStorage;
  prefix: string;
  vault: MemoryVault;
  state: MemoryStateStore;
  clock: FixedClock;
  id?: string;
  device?: string;
  safeSync?: Parameters<typeof createSyncEngine>[0]["safeSync"];
}): { engine: SyncEngine; log: MemoryLog } {
  const log = new MemoryLog();
  return {
    log,
    engine: createSyncEngine({
      storage: opts.storage,
      vault: opts.vault,
      crypto: new IdentityCrypto(),
      clock: opts.clock,
      log,
      state: opts.state,
      deviceId: opts.device ?? "dev-d",
      storagePrefix: opts.prefix,
      ...(opts.id !== undefined ? { vaultIdentity: opts.id } : {}),
      ...(opts.safeSync !== undefined ? { safeSync: opts.safeSync } : {}),
    }),
  };
}

/**
 * Vault B, long-lived, old generations pruned. This device synced vault A
 * with an Inbox.md of its own. Then the same state store meets vault B.
 */
async function switchStore(ids: { a?: string; b?: string }) {
  const storage = new MemoryStorage();
  const clock = new FixedClock();
  const other = new MemoryVault();
  const e = engine({
    storage,
    prefix: "vault-b",
    vault: other,
    state: new MemoryStateStore(),
    clock,
    device: "dev-e",
    safeSync: { generationsToKeep: 2 },
    ...(ids.b !== undefined ? { id: ids.b } : {}),
  }).engine;
  other.setFile("Inbox.md", "B's inbox — the other vault");
  for (let i = 0; i < 6; i++) {
    other.setFile(`b${String(i)}.md`, `b ${String(i)}`);
    await e.sync();
  }
  await e.reclaimStorage();

  const state = new MemoryStateStore();
  const local = new MemoryVault();
  const idA = ids.a !== undefined ? { id: ids.a } : {};
  const idB = ids.b !== undefined ? { id: ids.b } : {};
  const d = engine({ storage, prefix: "vault-a", vault: local, state, clock, ...idA });
  local.setFile("Inbox.md", "A's inbox — my notes, written here");
  await d.engine.sync();
  for (let i = 0; i < 2; i++) {
    local.setFile(`a${String(i)}.md`, `a ${String(i)}`);
    await d.engine.sync();
  }

  clock.advance(DAY);
  const d2 = engine({ storage, prefix: "vault-b", vault: local, state, clock, ...idB });
  const report = await d2.engine.sync();
  return { local, report, log: d2.log, state };
}

const text = async (v: MemoryVault, p: string): Promise<string> =>
  new TextDecoder().decode(await v.read(p));

describe("a base is tied to its vault (ADR-0079)", () => {
  it("another vault's base is not used: a conflict, not a silent overwrite", async () => {
    const { local, log } = await switchStore({ a: "salt:A", b: "salt:B" });
    expect(await text(local, "Inbox.md")).toBe("A's inbox — my notes, written here");
    expect(local.paths().some((p) => p.startsWith("Inbox") && p.includes("conflict"))).toBe(true);
    expect(log.notices.map((n) => n.code)).toContain("base-other-vault");
  });

  // What the plugin's per-location state files (ADR-0065) cover on their own.
  it("without identities the old behaviour stands", async () => {
    const { local } = await switchStore({});
    expect(await text(local, "Inbox.md")).toBe("B's inbox — the other vault");
  });

  it("the same vault keeps its base", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const state = new MemoryStateStore();
    const vault = new MemoryVault();
    const first = engine({ storage, prefix: "", vault, state, clock, id: "salt:A" });
    vault.setFile("a.md", "a");
    await first.engine.sync();
    const again = engine({ storage, prefix: "", vault, state, clock, id: "salt:A" });
    expect((await again.engine.status()).baseGeneration).not.toBeNull();
    expect(again.log.notices.map((n) => n.code)).not.toContain("base-other-vault");
  });

  it("a state written before identities is adopted, and recorded from then on", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const state = new MemoryStateStore();
    const vault = new MemoryVault();
    const legacy = engine({ storage, prefix: "", vault, state, clock });
    vault.setFile("a.md", "a");
    await legacy.engine.sync();
    const upgraded = engine({ storage, prefix: "", vault, state, clock, id: "salt:A" });
    expect((await upgraded.engine.status()).baseGeneration).not.toBeNull();
    vault.setFile("b.md", "bb");
    await upgraded.engine.sync();
    const elsewhere = engine({ storage, prefix: "", vault, state, clock, id: "salt:B" });
    expect((await elsewhere.engine.status()).baseGeneration).toBeNull();
  });

  it("an engine without an identity keeps the one it found", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock();
    const state = new MemoryStateStore();
    const vault = new MemoryVault();
    const tagged = engine({ storage, prefix: "", vault, state, clock, id: "salt:A" });
    vault.setFile("a.md", "a");
    await tagged.engine.sync();
    const plain = engine({ storage, prefix: "", vault, state, clock });
    // No identity of its own: nothing to compare, the base is used as before.
    expect((await plain.engine.status()).baseGeneration).not.toBeNull();
    expect(plain.log.notices.map((x) => x.code)).not.toContain("base-other-vault");
    vault.setFile("b.md", "bb");
    await plain.engine.sync();
    const elsewhere = engine({ storage, prefix: "", vault, state, clock, id: "salt:B" });
    expect((await elsewhere.engine.status()).baseGeneration).toBeNull();
  });
});
