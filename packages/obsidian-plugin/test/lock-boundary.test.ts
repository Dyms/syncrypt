// ADR-0066: locking ends a session — including the sync it was running and
// every dialog waiting on an answer.
//
// ADR-0048 bumped a session counter so an orphaned sync's REPORT was ignored,
// and called the rest harmless. Audit №4 showed it was not: after Lock →
// Unlock two engines ran on one vault (C5); a dialog answered after Lock acted
// through the dropped engine, or through the NEXT session's (B3); a second
// passphrase dialog could tear an open session down (B11); Escape during
// "Checking…" left the unlock running behind a closed window (B14); and the
// maintenance commands dropped their failures (B9).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "@syncrypt/core/testing";

import { ConfirmSyncModal } from "../src/confirm-modal.js";
import { EN_STRINGS } from "../src/i18n.js";
import { ReclaimStorageModal } from "../src/reclaim-modal.js";
import { PassphraseModal } from "../src/unlock.js";
import { PreviousSessionBusy } from "../src/unlock-error.js";
import { Modal, Notice, resetStub } from "./support/obsidian-stub.js";
import {
  engineOf,
  mainStore,
  makeDevice,
  PASS,
  S3_DATA,
  settle,
  unlock,
  waitFor,
  World,
} from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

/** Every read waits; a repeated read of one object waits longer — an uneven link. */
class SlowStorage extends MemoryStorage {
  delayMs = 0;
  private readonly seen = new Map<string, number>();
  override async get(key: string): Promise<Uint8Array> {
    const n = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, n);
    const d = this.delayMs * (n > 1 && key.includes("objects/") ? 3 : 1);
    if (d > 0) await new Promise((r) => setTimeout(r, d));
    return super.get(key);
  }
}

/** The stub's flag; Obsidian's own Modal type does not declare it. */
const isOpen = (m: unknown): boolean => (m as { isOpen: boolean }).isOpen;

/** "Sync failed: …" lines — a cancelled or overtaken sync must not write one. */
const failures = (d: { plugin: { log: { all(): readonly { text?: string }[] } } }): string[] =>
  d.plugin.log
    .all()
    .map((l) => l.text ?? "")
    .filter((t) => t.startsWith(EN_STRINGS.log.syncFailed("")));

const opened = <T>(cls: abstract new (...a: never[]) => T): T[] =>
  Modal.opened.filter((m): m is Modal & T => m instanceof cls);

describe("a lock stops the sync it ends (C5)", () => {
  it("Lock → Unlock during the startup pull runs one engine, not two", async () => {
    const world = new World(() => new SlowStorage());
    const seeder = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed" });
    for (let i = 0; i < 12; i++) {
      seeder.adapter.setFile(`n${String(i).padStart(2, "0")}.md`, `note ${String(i)}`);
    }
    await unlock(seeder.plugin, PASS, true);
    await settle(seeder.plugin);

    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    (mainStore(world) as SlowStorage).delayMs = 20;
    await unlock(me.plugin); // returns; the startup pull runs in the background
    await waitFor(() => me.adapter.files.has("n02.md"), "the pull to be under way");
    me.plugin.lock();
    await unlock(me.plugin);
    await settle(me.plugin);
    await new Promise((r) => setTimeout(r, 300));

    const copies = [...me.adapter.files.keys()].filter((k) => k.includes("conflicted copy"));
    expect(copies).toEqual([]);
    const applied = me.plugin.log
      .all()
      .filter((l) => l.level === "entry")
      .map((l) => l.path);
    expect(applied.filter((p, i) => applied.indexOf(p) !== i)).toEqual([]); // nothing twice
    for (let i = 0; i < 12; i++) {
      expect(me.adapter.getText(`n${String(i).padStart(2, "0")}.md`)).toBe(`note ${String(i)}`);
    }
  });
});

describe("a dialog answered after Lock does nothing (B3)", () => {
  it("Reclaim: the lock closes the dialog as 'no', and nothing is swept", async () => {
    const world = new World();
    const me = await makeDevice(world, S3_DATA);
    me.adapter.setFile("a.md", "a");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const sweep = vi.spyOn(engineOf(me), "reclaimStorage");

    const command = me.plugin.reclaimStorage();
    await waitFor(() => opened(ReclaimStorageModal).length === 1, "the reclaim dialog");
    me.plugin.lock();
    await command;

    expect(isOpen(opened(ReclaimStorageModal)[0])).toBe(false);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("Reclaim: a lock during the preview opens no dialog at all", async () => {
    const world = new World();
    const me = await makeDevice(world, S3_DATA);
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const engine = engineOf(me);
    const preview = engine.previewReclaim.bind(engine);
    vi.spyOn(engine, "previewReclaim").mockImplementation(async () => {
      const plan = await preview();
      me.plugin.lock();
      return plan;
    });
    await me.plugin.reclaimStorage();
    expect(opened(ReclaimStorageModal)).toEqual([]);
  });

  it("Safe Sync: Lock with the confirmation open applies nothing and says nothing raw", async () => {
    const world = new World();
    const strict = { bulkChangeFloor: 0, bulkChangeMaxFiles: 1, bulkChangeMaxFraction: 1 };
    const other = await makeDevice(world, { ...S3_DATA, deviceId: "dev-other" });
    for (const n of ["a", "b", "c"]) other.adapter.setFile(`${n}.md`, n);
    await unlock(other.plugin, PASS, true);
    await settle(other.plugin);

    const me = await makeDevice(world, {
      ...S3_DATA,
      safeSync: strict,
      autoSync: { enabled: false },
    });
    await unlock(me.plugin);
    await settle(me.plugin);
    for (const n of ["a", "b", "c"]) await other.adapter.remove(`${n}.md`);
    await engineOf(other).sync();

    const syncing = me.plugin.syncNow("manual");
    await waitFor(() => opened(ConfirmSyncModal).length === 1, "the Safe Sync dialog");
    me.plugin.lock();
    await syncing;

    expect(isOpen(opened(ConfirmSyncModal)[0])).toBe(false);
    for (const n of ["a", "b", "c"]) expect(me.adapter.getText(`${n}.md`)).toBe(n);
    expect(Notice.shown.filter((m) => m.includes("TypeError"))).toEqual([]);
  });
});

describe("one passphrase dialog, and it cannot be dismissed mid-check (B11, B14)", () => {
  it("asking twice opens one dialog", async () => {
    const world = new World();
    const me = await makeDevice(world, S3_DATA);
    me.plugin.promptUnlock();
    me.plugin.promptUnlock();
    expect(opened(PassphraseModal)).toHaveLength(1);
  });

  it("an unlock while unlocked does not even open the storage", async () => {
    const world = new World();
    const me = await makeDevice(world, S3_DATA);
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const p = me.plugin as unknown as { openStorage(): Promise<MemoryStorage> };
    const open = vi.spyOn(p, "openStorage");
    await unlock(me.plugin);
    expect(open).not.toHaveBeenCalled();
  });

  it("an unlock attempt while unlocked leaves the open session alone", async () => {
    const world = new World();
    const me = await makeDevice(world, S3_DATA);
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const engine = engineOf(me);
    await unlock(me.plugin, "a wrong passphrase");
    expect(engineOf(me)).toBe(engine);
  });

  it("Escape while the passphrase is being checked does not close the dialog", async () => {
    let finish = (): void => undefined;
    const modal = new PassphraseModal(
      {} as never,
      () => new Promise<void>((r) => (finish = r)),
      undefined,
      EN_STRINGS,
    );
    modal.open();
    (modal as unknown as { passphrase: string }).passphrase = "p";
    const submitted = (modal as unknown as { submit(): Promise<void> }).submit();
    modal.close(); // Escape
    expect(isOpen(modal)).toBe(true);
    finish();
    await submitted;
    expect(isOpen(modal)).toBe(false); // closed by the unlock that succeeded
  });
});

describe("maintenance commands say when they fail (B9)", () => {
  it("Reclaim on a storage that went backwards shows the refusal", async () => {
    const world = new World();
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    me.adapter.setFile("a.md", "a");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    me.adapter.now += 1000;
    me.adapter.setFile("a.md", "a, edited");
    await engineOf(me).sync();
    // The newest manifest disappears: a restore from an older backup.
    const store = mainStore(world);
    const manifests = store
      .keys()
      .filter((k) => k.includes("/manifests/"))
      .sort();
    const newest = manifests.at(-1);
    if (newest === undefined) throw new Error("no manifest");
    await store.delete(newest);

    await me.plugin.reclaimStorage();
    expect(opened(ReclaimStorageModal)).toEqual([]);
    expect(Notice.shown).toContain(
      EN_STRINGS.notices.commandFailed(EN_STRINGS.notices.commandRefused),
    );
  });
});

describe("the stopped sync is stopped, and waited for (C5, each half on its own)", () => {
  async function pulling(world: World): Promise<Awaited<ReturnType<typeof makeDevice>>> {
    const seeder = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed" });
    for (let i = 0; i < 12; i++) {
      seeder.adapter.setFile(`n${String(i).padStart(2, "0")}.md`, `note ${String(i)}`);
    }
    await unlock(seeder.plugin, PASS, true);
    await settle(seeder.plugin);
    return makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
  }
  const notes = (d: { adapter: { files: Map<string, unknown> } }): number =>
    [...d.adapter.files.keys()].filter((k) => /^n\d\d\.md$/.test(k)).length;

  it("after Lock the sync writes at most the file it was on", async () => {
    const world = new World(() => new SlowStorage());
    const me = await pulling(world);
    (mainStore(world) as SlowStorage).delayMs = 20;
    await unlock(me.plugin);
    await waitFor(() => me.adapter.files.has("n02.md"), "the pull to be under way");
    me.plugin.lock();
    const atLock = notes(me);
    await new Promise((r) => setTimeout(r, 600));
    expect(notes(me)).toBeLessThanOrEqual(atLock + 1);
    expect(notes(me)).toBeLessThan(12);
    // Cancelled by the lock, not failed: the log says "locked", nothing more.
    expect(failures(me)).toEqual([]);
  });

  it("the next unlock does not open beside the stopped sync — refused, not wedged (ADR-0081, Q4)", async () => {
    let release = (): void => undefined;
    let held = false;
    class Gate extends MemoryStorage {
      armed = false;
      override async get(key: string): Promise<Uint8Array> {
        if (this.armed && key.includes("objects/")) {
          this.armed = false;
          held = true;
          await new Promise<void>((r) => (release = r));
        }
        return super.get(key);
      }
    }
    const world = new World(() => new Gate());
    const me = await pulling(world);
    (mainStore(world) as Gate).armed = true;
    await unlock(me.plugin);
    await waitFor(() => held, "the pull to be inside a read");
    me.plugin.lock();
    // The stopped sync is still inside its read: no second engine, and the
    // unlock says so instead of holding the dialog for as long as it hangs.
    await expect(unlock(me.plugin)).rejects.toBeInstanceOf(PreviousSessionBusy);
    expect(me.plugin.isUnlocked()).toBe(false);
    release();
    await waitFor(
      () => (me.plugin as unknown as { running: unknown }).running === null,
      "the stopped sync to return",
    );
    await unlock(me.plugin);
    expect(me.plugin.isUnlocked()).toBe(true);
    await settle(me.plugin);
    expect(notes(me)).toBe(12);
  });
});

describe("two unlocks at once open one session", () => {
  const unlockedLines = (d: { plugin: { log: { all(): readonly { text?: string }[] } } }): number =>
    d.plugin.log.all().filter((l) => l.text === EN_STRINGS.log.unlocked).length;

  it("both succeed: the second does not replace the first", async () => {
    const world = new World();
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed" });
    seed.adapter.setFile("seed.md", "seed"); // published, so the passphrase can be checked
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    await Promise.all([unlock(me.plugin), unlock(me.plugin)]);
    await settle(me.plugin);
    expect(unlockedLines(me)).toBe(1);
  });

  it("a failing one does not tear down the one that succeeded", async () => {
    const world = new World();
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed" });
    // A published manifest, so a wrong passphrase is told apart at unlock.
    seed.adapter.setFile("seed.md", "seed");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    const p = me.plugin as unknown as { openStorage(): Promise<MemoryStorage> };
    const open = p.openStorage.bind(p);
    let calls = 0;
    p.openStorage = async () => {
      calls++;
      if (calls === 2) await new Promise((r) => setTimeout(r, 150)); // the slow, wrong one
      return open();
    };
    const right = unlock(me.plugin);
    const wrong = unlock(me.plugin, "not the passphrase").catch(() => undefined);
    await right;
    const engine = engineOf(me);
    await wrong;
    await settle(me.plugin);
    expect(engineOf(me)).toBe(engine);
  });
});

describe("an answer that a lock overtakes acts on nothing (B3)", () => {
  /** The dialog answers, and a lock lands before the command reads the answer. */
  function answerThenLock(d: { plugin: object }, answer: unknown): void {
    const plugin = d.plugin as { lock(): void };
    vi.spyOn(d.plugin as { ask(o: unknown): Promise<unknown> }, "ask").mockImplementation(
      () => {
        plugin.lock();
        return Promise.resolve(answer);
      },
    );
  }

  async function opened3(): Promise<Awaited<ReturnType<typeof makeDevice>>> {
    const world = new World();
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    me.adapter.setFile("a.md", "a");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    return me;
  }

  it("reclaim", async () => {
    const me = await opened3();
    const sweep = vi.spyOn(engineOf(me), "reclaimStorage");
    answerThenLock(me, true);
    await me.plugin.reclaimStorage();
    expect(sweep).not.toHaveBeenCalled();
    expect(Notice.shown).toContain(EN_STRINGS.notices.lockedMeanwhile);
  });

  it("forget", async () => {
    const me = await opened3();
    const engine = engineOf(me);
    vi.spyOn(engine, "listUncarried").mockResolvedValue([
      { path: "x.md", size: 1, mtime: 1, hash: "h" },
    ]);
    const forget = vi.spyOn(engine, "forgetPaths");
    answerThenLock(me, ["x.md"]);
    await me.plugin.reviewManifest();
    expect(forget).not.toHaveBeenCalled();
    expect(Notice.shown).toContain(EN_STRINGS.notices.lockedMeanwhile);
  });

  it("release", async () => {
    const me = await opened3();
    const engine = engineOf(me);
    vi.spyOn(engine, "previewRelease").mockResolvedValue(["objects/aa", "objects/bb"]);
    const release = vi.spyOn(engine, "releaseForgotten");
    answerThenLock(me, true);
    await me.plugin.releaseForgotten();
    expect(release).not.toHaveBeenCalled();
    expect(Notice.shown).toContain(EN_STRINGS.notices.lockedMeanwhile);
  });

  it("accept storage", async () => {
    const me = await opened3();
    const engine = engineOf(me);
    const real = await engine.status();
    vi.spyOn(engine, "status").mockResolvedValue({ ...real, baseGeneration: 5 });
    vi.spyOn(engine, "verifyAccess").mockResolvedValue({ generation: 1 } as never);
    const forget = vi.spyOn(engine, "acceptRolledBack");
    answerThenLock(me, true);
    await me.plugin.acceptStorage();
    expect(forget).not.toHaveBeenCalled();
    expect(Notice.shown).toContain(EN_STRINGS.notices.lockedMeanwhile);
  });

  async function confirming(): Promise<{
    me: Awaited<ReturnType<typeof makeDevice>>;
    other: Awaited<ReturnType<typeof makeDevice>>;
  }> {
    const world = new World();
    const strict = { bulkChangeFloor: 0, bulkChangeMaxFiles: 1, bulkChangeMaxFraction: 1 };
    const other = await makeDevice(world, { ...S3_DATA, deviceId: "dev-other" });
    for (const n of ["a", "b", "c"]) other.adapter.setFile(`${n}.md`, n);
    await unlock(other.plugin, PASS, true);
    await settle(other.plugin);
    const me = await makeDevice(world, { ...S3_DATA, safeSync: strict, autoSync: { enabled: false } });
    await unlock(me.plugin);
    await settle(me.plugin);
    for (const n of ["a", "b", "c"]) await other.adapter.remove(`${n}.md`);
    await engineOf(other).sync();
    return { me, other };
  }

  it("Safe Sync: Apply that a lock overtakes applies nothing", async () => {
    const { me } = await confirming();
    const apply = vi.spyOn(engineOf(me), "confirmAndApply");
    answerThenLock(me, true);
    await me.plugin.syncNow("manual");
    expect(apply).not.toHaveBeenCalled();
    for (const n of ["a", "b", "c"]) expect(me.adapter.getText(`${n}.md`)).toBe(n);
    expect(failures(me)).toEqual([]);
  });

  it("Safe Sync: a lock just after the plan is computed opens no dialog", async () => {
    const { me } = await confirming();
    const engine = engineOf(me);
    const dry = engine.dryRun.bind(engine);
    vi.spyOn(engine, "dryRun").mockImplementation(async (s) => {
      const plan = await dry(s);
      me.plugin.lock(); // after the scan's last cancellation check
      return plan;
    });
    await me.plugin.syncNow("manual");
    expect(opened(ConfirmSyncModal)).toEqual([]);
  });

  it("a real failure of an ended session's sync is still written down", async () => {
    const { me } = await confirming();
    vi.spyOn(engineOf(me), "sync").mockImplementation(() => {
      me.plugin.lock();
      return Promise.reject(new Error("disk on fire"));
    });
    await me.plugin.syncNow("manual");
    expect(failures(me)).toHaveLength(1);
  });

  it("Safe Sync: a lock while the plan is computed opens no dialog", async () => {
    const { me } = await confirming();
    const engine = engineOf(me);
    const dry = engine.dryRun.bind(engine);
    vi.spyOn(engine, "dryRun").mockImplementation((s) => {
      me.plugin.lock(); // lands while the plan is computed: the scan is cancelled
      return dry(s);
    });
    await me.plugin.syncNow("manual");
    expect(opened(ConfirmSyncModal)).toEqual([]);
    expect(failures(me)).toEqual([]); // cancelled by the lock, not a failure
  });
});
