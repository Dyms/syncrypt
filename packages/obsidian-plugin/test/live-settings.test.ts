// ADR-0072: profile, Safe Sync and auto-sync timings edited while unlocked
// reach the open vault port, engine and scheduler — between syncs. Audit №4:
// a tightened breaker did not fire until a lock (A3); a folder added to
// Exclude kept uploading while "Count files" showed it excluded (A4/C3); a
// keystroke in a timing field dropped the pending auto-sync (A6/C9).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EN_STRINGS } from "../src/i18n.js";
import { resetStub } from "./support/obsidian-stub.js";
import {
  engineOf,
  field,
  makeDevice,
  PASS,
  renderTab,
  S3_DATA,
  settle,
  unlock,
  World,
} from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const T = EN_STRINGS.settings;

async function opened(extra: object = {}) {
  const world = new World();
  const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false }, ...extra });
  for (const n of ["a", "b", "c"]) me.adapter.setFile(`${n}.md`, n);
  me.adapter.setFile("Private/old.md", "synced before the exclude");
  await unlock(me.plugin, PASS, true);
  await settle(me.plugin);
  return { world, me };
}

describe("Safe Sync edits reach the open engine (A3)", () => {
  it("a breaker tightened in Settings fires on the next sync", async () => {
    const { me } = await opened();
    renderTab(me);
    await field(T.confirmationFloor).type("0");
    await field(T.alwaysConfirmAt).type("1");
    for (const n of ["a", "b", "c"]) await me.adapter.remove(`${n}.md`);
    const report = await engineOf(me).sync();
    expect(report.outcome).toBe("needs-confirmation");
  });
});

describe("profile edits reach the open vault port (A4/C3)", () => {
  it("a folder added to Exclude stops uploading once the field is left", async () => {
    const { me } = await opened();
    renderTab(me);
    await field(T.exclude).type("Private");
    field(T.exclude).inputEl.dispatch("blur"); // ADR-0081, R5
    me.adapter.setFile("Private/diary.md", "not for the other devices");
    const report = await engineOf(me).sync();
    expect(report.entries.map((e) => e.path)).not.toContain("Private/diary.md");
  });

  it("…and does not tombstone what was synced from it before", async () => {
    const { me } = await opened();
    renderTab(me);
    await field(T.exclude).type("Private");
    field(T.exclude).inputEl.dispatch("blur");
    const report = await engineOf(me).sync();
    expect(report.entries.filter((e) => e.kind === "delete-remote")).toEqual([]);
  });

  it("an edit made during a sync applies after it, not inside it", async () => {
    const { me } = await opened();
    const engine = engineOf(me);
    const sync = engine.sync.bind(engine);
    let profileDuring: boolean | undefined;
    vi.spyOn(engine, "sync").mockImplementationOnce(async (signal) => {
      renderTab(me);
      await field(T.exclude).type("Private"); // typed while the sync runs
      field(T.exclude).inputEl.dispatch("blur"); // …and left
      const port = (me.plugin as unknown as { vaultPort: { syncable(p: string): boolean } })
        .vaultPort;
      profileDuring = port.syncable("Private/x.md");
      return sync(signal);
    });
    await me.plugin.syncNow("manual");
    expect(profileDuring).toBe(true); // the running sync kept its profile
    const port = (me.plugin as unknown as { vaultPort: { syncable(p: string): boolean } })
      .vaultPort;
    expect(port.syncable("Private/x.md")).toBe(false); // applied once it finished
  });
});

describe("a half-typed pattern does not reach a sync (ADR-0081, R5)", () => {
  it("keystrokes are saved, not applied: a sync mid-typing plans with the old profile", async () => {
    const { me } = await opened();
    renderTab(me);
    await field(T.exclude).type("*"); // on the way to "*.pdf"
    const port = (me.plugin as unknown as { vaultPort: { syncable(p: string): boolean } })
      .vaultPort;
    expect(port.syncable("todo.md")).toBe(true);
    expect(me.plugin.settings.profile.exclude).toContain("*"); // saved all the same
    await field(T.exclude).type("*.pdf");
    field(T.exclude).inputEl.dispatch("blur");
    expect(port.syncable("todo.md")).toBe(true);
    expect(port.syncable("scan.pdf")).toBe(false);
  });

  it("closing the settings tab applies a pending edit", async () => {
    const { me } = await opened();
    const tab = renderTab(me);
    await field(T.exclude).type("Private");
    tab.hide();
    const port = (me.plugin as unknown as { vaultPort: { syncable(p: string): boolean } })
      .vaultPort;
    expect(port.syncable("Private/x.md")).toBe(false);
  });
});

describe("timing edits keep the pending auto-sync (A6/C9)", () => {
  it("an edit made just before changing the debounce still syncs", async () => {
    // Unlocked on real timers (key derivation); the scheduler's own timers fake.
    const { me } = await opened({ autoSync: { enabled: true, debounceSec: 15 } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const syncNow = vi.spyOn(me.plugin, "syncNow").mockResolvedValue();
      const scheduler = (me.plugin as unknown as { scheduler: { noteChange(): void } }).scheduler;
      scheduler.noteChange(); // an edit
      renderTab(me);
      await field(T.debounce).type("10");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(syncNow).toHaveBeenCalledWith("auto");
    } finally {
      vi.useRealTimers();
    }
  });
});
