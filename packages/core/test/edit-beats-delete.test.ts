// ADR-0061. ADR-0053 established that a scan is not the filesystem: between
// the scan and the apply, a path the scan reported as absent can exist — the
// user created it, or the path folds onto one the scan saw under another
// spelling. The download branch got a `vault.stat` guard for that. The
// conflict branch's creation arm, which is the SAME situation reached from the
// other direction, did not, and wrote over whatever was there: no trash, no
// conflicted copy, and a report that said "conflict" while the user's bytes
// were gone.

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

/**
 * A vault that stops LISTING a path while still holding the file — which is
 * what every version of this situation looks like to the engine: the scan did
 * not see it, and the filesystem has it.
 */
class HidesFromList extends MemoryVault {
  hidden: VaultPath | null = null;
  override async *list(): AsyncIterable<VaultPath> {
    for await (const p of super.list()) if (p !== this.hidden) yield p;
  }
}

function device(
  storage: MemoryStorage,
  id: string,
  vault: MemoryVault,
  clock: FixedClock,
): SyncEngine {
  return createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock,
    log: new MemoryLog(),
    state: new MemoryStateStore(),
    deviceId: id,
    storagePrefix: "",
    safeSync: { bulkChangeMaxFraction: 1 },
  });
}

/** A published vault, a second device that has it, and a remote edit pending. */
async function remoteEditPending(): Promise<{
  engine: SyncEngine;
  vault: HidesFromList;
}> {
  const storage = new MemoryStorage();
  const clock = new FixedClock(1_000_000);

  const laptopVault = new MemoryVault();
  const laptop = device(storage, "laptop", laptopVault, clock);
  laptopVault.setFile("note.md", "ORIGINAL");
  await laptop.sync();

  const phoneVault = new HidesFromList();
  const phone = device(storage, "phone", phoneVault, clock);
  await phone.sync();
  expect(phoneVault.getText("note.md")).toBe("ORIGINAL");

  laptopVault.now += 10;
  laptopVault.setFile("note.md", "THE REMOTE EDIT");
  await laptop.sync();

  return { engine: phone, vault: phoneVault };
}

describe("edit beats delete, and never over a file that is there", () => {
  it("THE LOCAL FILE IS NOT OVERWRITTEN, AND THE REMOTE EDIT ARRIVES BESIDE IT", async () => {
    const { engine, vault } = await remoteEditPending();

    // The scan does not see the path; the file is there with the user's work.
    vault.hidden = "note.md";
    vault.now += 20;
    vault.setFile("note.md", "LOCAL WORK THE USER WANTS");

    const report = await engine.sync();

    expect(report.conflicts).toEqual(["note.md"]);
    // The user's bytes, untouched.
    expect(vault.getText("note.md")).toBe("LOCAL WORK THE USER WANTS");
    // And the remote version, somewhere they can find it.
    const copies = [...vault.paths()].filter((p) => p !== "note.md");
    expect(copies).toHaveLength(1);
    expect(vault.getText(copies[0] ?? "")).toBe("THE REMOTE EDIT");
    // Nothing was trashed: nothing had to be.
    expect(vault.trashed).toEqual([]);
  });

  it("and the report says a copy was saved, with its path", async () => {
    const { engine, vault } = await remoteEditPending();
    vault.hidden = "note.md";
    vault.now += 20;
    vault.setFile("note.md", "LOCAL WORK");

    const report = await engine.sync();
    const entry = report.entries.find((e) => e.path === "note.md");
    expect(entry?.detail?.code).toBe("conflict-copy-saved");
    if (entry?.detail?.code === "conflict-copy-saved") {
      expect(vault.getText(entry.detail.copyPath)).toBe("THE REMOTE EDIT");
    }
  });

  it("A PATH THAT REALLY IS GONE STILL GETS THE REMOTE VERSION BACK", async () => {
    // The other half, and the behaviour ADR-0010 promises: edit beats delete.
    // The guard must not turn a genuine restore into a conflicted copy.
    const { engine, vault } = await remoteEditPending();
    await vault.delete("note.md");

    const report = await engine.sync();

    expect(vault.getText("note.md")).toBe("THE REMOTE EDIT");
    expect([...vault.paths()]).toEqual(["note.md"]);
    const entry = report.entries.find((e) => e.path === "note.md");
    expect(entry?.detail?.code).toBe("remote-edit-restored");
  });
});
