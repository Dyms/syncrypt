// ADR-0064. A pull applies a plan made from a scan, minutes later on a big
// vault, while the user keeps working. An op decided against the content the
// scan saw must not land on a file that has changed since:
//   - an update used to overwrite the edit in place — no copy, no trash, and
//     the next sync saw local == base and had nothing to say;
//   - a remote deletion used to file the NEW edit in the trash as if it were
//     the old version.
// ADR-0053 closed this window for creations only.

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

/** The user saves `target` at the moment the pull writes `trigger`. */
class TypingVault extends MemoryVault {
  armed: { trigger: VaultPath; target: VaultPath; text: string } | null = null;
  override write(path: VaultPath, data: Uint8Array): Promise<void> {
    const a = this.armed;
    if (a !== null && path === a.trigger) {
      this.armed = null;
      this.now += 5;
      this.setFile(a.target, a.text);
    }
    return super.write(path, data);
  }
  override trash(path: VaultPath): Promise<void> {
    const a = this.armed;
    if (a !== null && path === a.trigger) {
      this.armed = null;
      this.now += 5;
      this.setFile(a.target, a.text);
    }
    return super.trash(path);
  }
}

function device(
  storage: MemoryStorage,
  id: string,
  vault: MemoryVault,
  safeSync?: { bulkChangeFloor: number; bulkChangeMaxFiles: number },
) {
  const log = new MemoryLog();
  const engine: SyncEngine = createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock: new FixedClock(),
    log,
    state: new MemoryStateStore(),
    deviceId: id,
    storagePrefix: "",
    ...(safeSync !== undefined ? { safeSync } : {}),
  });
  return { engine, vault, log };
}

/** Like TypingVault, and the saved file is then held open: unreadable. */
class TypingAndHoldingVault extends TypingVault {
  heldOpen: VaultPath | null = null;
  override write(path: VaultPath, data: Uint8Array): Promise<void> {
    const target = this.armed?.trigger === path ? this.armed.target : null;
    const done = super.write(path, data);
    if (target !== null) this.heldOpen = target;
    return done;
  }
  override read(path: VaultPath): Promise<Uint8Array> {
    if (path === this.heldOpen) return Promise.reject(new Error("EBUSY"));
    return super.read(path);
  }
}

async function texts(v: MemoryVault): Promise<string[]> {
  const out: string[] = [];
  for await (const path of v.list()) out.push(v.getText(path) ?? "");
  return out;
}

describe("a file saved while the pull is applying (ADR-0064)", () => {
  it("an update does not overwrite it; the next sync keeps both versions", async () => {
    const storage = new MemoryStorage();
    const one = device(storage, "one", new MemoryVault());
    one.vault.setFile("a.md", "a1");
    one.vault.setFile("z.md", "z1");
    await one.engine.sync();
    const two = device(storage, "two", new TypingVault());
    await two.engine.sync();

    one.vault.now += 10;
    one.vault.setFile("a.md", "a2 from one");
    one.vault.setFile("z.md", "z2 from one");
    await one.engine.sync();

    (two.vault as TypingVault).armed = {
      trigger: "a.md",
      target: "z.md",
      text: "z typed on two during the pull",
    };
    await two.engine.sync();

    expect(two.vault.getText("a.md")).toBe("a2 from one"); // untouched files still land
    expect(two.vault.getText("z.md")).toBe("z typed on two during the pull");
    expect(two.log.notices).toContainEqual({
      code: "paths-changed-during-sync",
      paths: ["z.md"],
    });

    await two.engine.sync();
    await one.engine.sync();
    for (const side of [one.vault, two.vault]) {
      expect(await texts(side)).toContain("z typed on two during the pull");
      expect(await texts(side)).toContain("z2 from one");
    }
  });

  it("a remote deletion does not send the new edit to the trash", async () => {
    const storage = new MemoryStorage();
    const one = device(storage, "one", new MemoryVault());
    one.vault.setFile("a.md", "a1");
    one.vault.setFile("z.md", "z1");
    await one.engine.sync();
    const two = device(storage, "two", new TypingVault());
    await two.engine.sync();

    await one.vault.delete("a.md");
    await one.vault.delete("z.md");
    await one.engine.sync();

    (two.vault as TypingVault).armed = {
      trigger: "a.md",
      target: "z.md",
      text: "z rewritten on two during the pull",
    };
    await two.engine.sync();
    expect(two.vault.getText("a.md")).toBeNull();
    expect(two.vault.getText("z.md")).toBe("z rewritten on two during the pull");
    expect((await texts(two.vault)).filter((t) => t === "z rewritten on two during the pull")).toHaveLength(1);

    // Edit beats delete: the next syncs carry it back to the other device.
    await two.engine.sync();
    await one.engine.sync();
    expect(one.vault.getText("z.md")).toBe("z rewritten on two during the pull");
  });

  it("an untouched file is not re-read to prove it is untouched", async () => {
    // The check costs a stat. The hash cache answers the rest; a re-read per
    // downloaded update would double the I/O of every pull.
    const storage = new MemoryStorage();
    const one = device(storage, "one", new MemoryVault());
    for (const n of ["a", "b", "c"]) one.vault.setFile(`${n}.md`, `${n}1`);
    await one.engine.sync();
    const two = device(storage, "two", new MemoryVault());
    await two.engine.sync();
    one.vault.now += 10;
    for (const n of ["a", "b", "c"]) one.vault.setFile(`${n}.md`, `${n}2, longer`);
    await one.engine.sync();

    await two.engine.status(); // a scan that fills the cache, as a sync would
    two.vault.reads.length = 0;
    await two.engine.pull();
    expect(two.vault.reads).toEqual([]);
    for (const n of ["a", "b", "c"]) expect(two.vault.getText(`${n}.md`)).toBe(`${n}2, longer`);
  });

  it("a file saved and then held open is not written over on the guess that it is unchanged", async () => {
    const storage = new MemoryStorage();
    const one = device(storage, "one", new MemoryVault());
    one.vault.setFile("a.md", "a1");
    one.vault.setFile("z.md", "z1");
    await one.engine.sync();
    const two = device(storage, "two", new TypingAndHoldingVault());
    await two.engine.sync();
    one.vault.now += 10;
    one.vault.setFile("a.md", "a2 from one");
    one.vault.setFile("z.md", "z2 from one");
    await one.engine.sync();

    (two.vault as TypingAndHoldingVault).armed = {
      trigger: "a.md",
      target: "z.md",
      text: "z saved on two, then held open",
    };
    await two.engine.pull();
    expect(two.vault.getText("z.md")).toBe("z saved on two, then held open");
  });

  it("the same holds when the pull runs from a Safe Sync confirmation", async () => {
    const storage = new MemoryStorage();
    const strict = { bulkChangeFloor: 0, bulkChangeMaxFiles: 0 };
    const one = device(storage, "one", new MemoryVault());
    one.vault.setFile("a.md", "a1");
    one.vault.setFile("z.md", "z1");
    await one.engine.sync();
    const two = device(storage, "two", new TypingVault(), strict);
    await two.engine.sync();
    one.vault.now += 10;
    one.vault.setFile("a.md", "a2 from one");
    one.vault.setFile("z.md", "z2 from one");
    await one.engine.sync();

    const plan = await two.engine.dryRun();
    expect(plan.requiresConfirmation).toBe(true);
    (two.vault as TypingVault).armed = {
      trigger: "a.md",
      target: "z.md",
      text: "z typed on two while the confirmed plan applied",
    };
    await two.engine.confirmAndApply(plan);
    expect(two.vault.getText("z.md")).toBe("z typed on two while the confirmed plan applied");
    expect(two.log.notices).toContainEqual({ code: "paths-changed-during-sync", paths: ["z.md"] });

    await two.engine.sync();
    await one.engine.sync();
    for (const side of [one.vault, two.vault]) {
      expect(await texts(side)).toContain("z typed on two while the confirmed plan applied");
      expect(await texts(side)).toContain("z2 from one");
    }
  });
});
