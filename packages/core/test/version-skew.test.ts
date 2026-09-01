// ADR-0036: a vault shared by mismatched clients says so.
//
// The asymmetry is the whole point and is worth stating in a test: an older
// client cannot be taught anything by a newer one — it does not have the code.
// So the useful direction is telling a PERSON which of their devices is stale.

import { describe, expect, it } from "vitest";

import { createSyncEngine, parseManifest } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

const clock = new FixedClock();

function device(storage: MemoryStorage, id: string, clientVersion?: string) {
  const vault = new MemoryVault();
  const log = new MemoryLog();
  const config: Parameters<typeof createSyncEngine>[0] = {
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock,
    log,
    state: new MemoryStateStore(),
    deviceId: id,
    storagePrefix: "",
    ...(clientVersion !== undefined ? { clientVersion } : {}),
  };
  return { engine: createSyncEngine(config), vault, log };
}

const skewNotices = (log: MemoryLog) =>
  log.notices.filter(
    (n) => n.code === "vault-written-by-newer" || n.code === "vault-written-by-older",
  );

async function topManifest(storage: MemoryStorage) {
  const key = storage.keys().filter((k) => k.startsWith("manifests/")).sort().at(-1) ?? "";
  return parseManifest(await storage.get(key));
}

describe("what a published manifest records", () => {
  it("carries the version that published it", async () => {
    const storage = new MemoryStorage();
    const d = device(storage, "dev-1", "1.0.0-beta.10");
    d.vault.setFile("note.md", "hello");
    await d.engine.sync();
    expect((await topManifest(storage)).writer).toBe("1.0.0-beta.10");
  }, 30_000);

  it("records nothing when the client does not say — and that still parses", async () => {
    const storage = new MemoryStorage();
    const d = device(storage, "dev-1");
    d.vault.setFile("note.md", "hello");
    await d.engine.sync();
    expect((await topManifest(storage)).writer).toBeUndefined();
    expect(skewNotices(d.log)).toEqual([]);
  }, 30_000);
});

describe("a vault shared by mismatched clients", () => {
  it("tells the OLDER device that it is the stale one", async () => {
    const storage = new MemoryStorage();
    const newer = device(storage, "dev-a", "1.0.0-beta.10");
    newer.vault.setFile("note.md", "published by the newer client");
    await newer.engine.sync();

    const older = device(storage, "dev-b", "1.0.0-beta.9");
    await older.engine.pull();

    expect(skewNotices(older.log)).toEqual([
      { code: "vault-written-by-newer", writer: "1.0.0-beta.10", self: "1.0.0-beta.9" },
    ]);
  }, 30_000);

  it("tells the NEWER device that something old is also writing here", async () => {
    const storage = new MemoryStorage();
    const older = device(storage, "dev-a", "1.0.0-beta.9");
    older.vault.setFile("note.md", "published by the older client");
    await older.engine.sync();

    const newer = device(storage, "dev-b", "1.0.0-beta.10");
    await newer.engine.pull();

    expect(skewNotices(newer.log)).toEqual([
      { code: "vault-written-by-older", writer: "1.0.0-beta.9", self: "1.0.0-beta.10" },
    ]);
  }, 30_000);

  it("a manifest with NO recorded writer is evidence of a client older still", async () => {
    // Versions were not recorded before ADR-0036, so an absent writer is not
    // "unknown" — it is a client that predates the record.
    const storage = new MemoryStorage();
    const ancient = device(storage, "dev-a"); // records nothing
    ancient.vault.setFile("note.md", "published by something old");
    await ancient.engine.sync();

    const current = device(storage, "dev-b", "1.0.0-beta.10");
    await current.engine.pull();
    expect(skewNotices(current.log)).toEqual([
      { code: "vault-written-by-older", writer: undefined, self: "1.0.0-beta.10" },
    ]);
  }, 30_000);

  it("says nothing at all when the versions match", async () => {
    const storage = new MemoryStorage();
    const a = device(storage, "dev-a", "1.0.0-beta.10");
    a.vault.setFile("note.md", "hello");
    await a.engine.sync();
    const b = device(storage, "dev-b", "1.0.0-beta.10");
    await b.engine.sync();
    expect(skewNotices(a.log)).toEqual([]);
    expect(skewNotices(b.log)).toEqual([]);
  }, 30_000);

  it("says it ONCE per session, not on every sync", async () => {
    const storage = new MemoryStorage();
    const newer = device(storage, "dev-a", "1.0.0-beta.10");
    newer.vault.setFile("note.md", "hello");
    await newer.engine.sync();

    const older = device(storage, "dev-b", "1.0.0-beta.9");
    for (let i = 0; i < 4; i++) {
      older.vault.setFile(`local-${String(i)}.md`, "x".repeat(i + 1));
      await older.engine.sync();
    }
    expect(skewNotices(older.log)).toHaveLength(1);
  }, 30_000);

  it("keeps syncing — this warns, it does not block", async () => {
    const storage = new MemoryStorage();
    const newer = device(storage, "dev-a", "1.0.0-beta.10");
    newer.vault.setFile("note.md", "from the newer client");
    await newer.engine.sync();

    const older = device(storage, "dev-b", "1.0.0-beta.9");
    const report = await older.engine.pull();
    expect(report.outcome).toBe("applied");
    expect(older.vault.getText("note.md")).toBe("from the newer client");
  }, 30_000);
});
