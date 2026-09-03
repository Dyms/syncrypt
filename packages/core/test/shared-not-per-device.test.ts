// ADR-0045. Two settings that live on ONE device and act on EVERY device.

import { describe, expect, it } from "vitest";

import { createSyncEngine, gcMarkKey, parseManifest, type SyncEngine } from "../src/index.js";
import {
  FixedClock, IdentityCrypto, MemoryLog, MemoryStateStore, MemoryStorage, MemoryVault,
} from "../src/testing/index.js";

const clock = new FixedClock();
function device(storage: MemoryStorage, id: string, over: Record<string, unknown> = {}): {
  engine: SyncEngine; vault: MemoryVault; log: MemoryLog;
} {
  const vault = new MemoryVault(); const log = new MemoryLog();
  return {
    engine: createSyncEngine({
      storage, vault, crypto: new IdentityCrypto(), clock, log,
      state: new MemoryStateStore(), deviceId: id, storagePrefix: "", ...over,
    }),
    vault, log,
  };
}

async function historyDepth(storage: MemoryStorage, path: string): Promise<number> {
  const key = storage.keys().filter((k) => k.startsWith("manifests/")).sort().reverse()[0] ?? "";
  const m = parseManifest(await new IdentityCrypto().decrypt("manifest", await storage.get(key)));
  return (m.history?.[path] ?? []).length;
}

describe("versionsToKeep is a per-device setting on shared history", () => {
  it("a device that keeps fewer does not discard what another retained", async () => {
    const storage = new MemoryStorage();
    const desktop = device(storage, "dev-a-desktop", { safeSync: { versionsToKeep: 5 } });
    const phone = device(storage, "dev-b-phone", { safeSync: { versionsToKeep: 1 } });

    desktop.vault.setFile("note.md", "v1");
    await desktop.engine.sync();
    for (const text of ["v2 is longer", "v3 is longer still", "v4 longer again yet"]) {
      desktop.vault.setFile("note.md", text);
      await desktop.engine.sync();
    }
    await phone.engine.sync();
    const before = await historyDepth(storage, "note.md");
    expect(before).toBe(3);

    phone.vault.setFile("note.md", "an edit made on the phone, longer than the rest");
    await phone.engine.sync();

    // The phone may rotate the list. It may not shorten it — those versions
    // are the only copies of the desktop's history, and reclamation deletes
    // the ciphertext of anything the manifest stops pointing at.
    expect(await historyDepth(storage, "note.md")).toBe(before);
  }, 30_000);

  it("a device that keeps MORE still only adds its own version", async () => {
    const storage = new MemoryStorage();
    const phone = device(storage, "dev-a-phone", { safeSync: { versionsToKeep: 1 } });
    const desktop = device(storage, "dev-b-desktop", { safeSync: { versionsToKeep: 5 } });
    phone.vault.setFile("note.md", "v1");
    await phone.engine.sync();
    phone.vault.setFile("note.md", "v2 is a bit longer");
    await phone.engine.sync();
    await desktop.engine.sync();
    expect(await historyDepth(storage, "note.md")).toBe(1);

    desktop.vault.setFile("note.md", "v3 from the desktop, longer still");
    await desktop.engine.sync();
    expect(await historyDepth(storage, "note.md")).toBe(2);
  }, 30_000);
});

describe("an interrupted reclaim does not restart everyone's grace clocks", () => {
  it("leaves the mark exactly as the completed run left it", async () => {
    const storage = new MemoryStorage();
    const opts = { safeSync: { versionsToKeep: 0, generationsToKeep: 1, reclaimGraceSeconds: 86_400 } };
    const d = device(storage, "dev-a", opts);
    d.vault.setFile("a.md", "first content here");
    await d.engine.sync();
    d.vault.setFile("a.md", "second content, of a different length");
    await d.engine.sync();

    await d.engine.reclaimStorage(); // marks the orphan, deletes nothing yet
    const mark = async (): Promise<string> =>
      storage
        .get(gcMarkKey("dev-a"))
        .then((b) => new TextDecoder().decode(b), () => "MISSING");
    const after1 = await mark();
    expect(after1).not.toBe("MISSING");

    const ac = new AbortController();
    ac.abort();
    const result = await d.engine.reclaimStorage(ac.signal);

    expect(result.deleted).toEqual([]);
    expect(await mark()).toBe(after1);
    // …and cancelling is not a rollback: the ADR-0041 guard reads a cancelled
    // listing as "generation 0", which it must not mistake for one.
    expect(d.log.notices.some((n) => n.code === "storage-rolled-back")).toBe(false);
  }, 30_000);
});
