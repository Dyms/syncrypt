// ADR-0073: "Synced" never runs ahead of the truth after a local edit.
// Audit №4 (C4): the vault-event handler re-rendered with the dirty count of
// the LAST status — zero — so an edit showed "Synced", for good with auto-sync
// off, and over "waiting for Wi-Fi" on a phone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetStub } from "./support/obsidian-stub.js";
import { emit, makeDevice, PASS, S3_DATA, settle, unlock, World } from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
  vi.stubGlobal("navigator", { onLine: true }); // Node has no onLine
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function synced() {
  const me = await makeDevice(new World(), { ...S3_DATA, autoSync: { enabled: false } });
  me.adapter.setFile("a.md", "a");
  await unlock(me.plugin, PASS, true);
  await settle(me.plugin);
  expect(me.plugin.getStatusView().kind).toBe("synced");
  return me;
}

describe("the status after a local edit (ADR-0073)", () => {
  it("an edit is pending at once, not 'Synced'", async () => {
    const me = await synced();
    me.adapter.now += 1000;
    me.adapter.setFile("a.md", "a, edited");
    emit(me, "modify", "a.md");
    expect(me.plugin.getStatusView().kind).not.toBe("synced");
  });

  it("…and stays pending once the real count is read", async () => {
    const me = await synced(); // real timers: key derivation
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      me.adapter.now += 1000;
      me.adapter.setFile("a.md", "a, edited");
      emit(me, "modify", "a.md");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(me.plugin.getStatusView().kind).not.toBe("synced");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an event that changed nothing settles back to 'Synced'", async () => {
    const me = await synced(); // real timers: key derivation
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const bar = (me.plugin as unknown as { statusEl: { text: string } }).statusEl;
      const syncedLabel = bar.text;
      emit(me, "modify", "a.md"); // our own write echoing back, or an undo
      expect(bar.text).not.toBe(syncedLabel);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(me.plugin.getStatusView().kind).toBe("synced");
      expect(bar.text).toBe(syncedLabel); // and the bar shows it
    } finally {
      vi.useRealTimers();
    }
  });

  it("the next sync makes it 'Synced' again", async () => {
    const me = await synced();
    me.adapter.now += 1000;
    me.adapter.setFile("a.md", "a, edited");
    emit(me, "modify", "a.md");
    await me.plugin.syncNow("manual");
    expect(me.plugin.getStatusView().kind).toBe("synced");
  });

  it("a lock cancels the pending re-read", async () => {
    const me = await synced(); // real timers: key derivation
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      emit(me, "modify", "a.md");
      me.plugin.lock();
      const status = vi.fn();
      // A later session's engine and port, which a stale timer must not ask.
      Object.assign(me.plugin, {
        engine: { status },
        vaultPort: { list: () => [][Symbol.iterator]() },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(status).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the live counter with a full log (ADR-0073)", () => {
  it("LogBuffer counts entries past its capacity", async () => {
    const { LogBuffer } = await import("../src/log-buffer.js");
    const log = new LogBuffer(3);
    for (let i = 0; i < 10; i++) log.entry({ path: `n${String(i)}.md` } as never);
    expect(log.all()).toHaveLength(3);
    expect(log.entryCount()).toBe(10);
    log.info("not an entry");
    expect(log.entryCount()).toBe(10);
  });

  it("'syncing (n)' counts this sync's files after 500 lines of history", async () => {
    const me = await synced();
    for (let i = 0; i < 600; i++) me.plugin.log.entry({ path: `old${String(i)}.md` } as never);
    let during = "";
    const engine = (me.plugin as unknown as { engine: { sync: (s?: AbortSignal) => unknown } })
      .engine;
    const sync = engine.sync.bind(engine);
    vi.spyOn(engine, "sync").mockImplementationOnce((signal?: AbortSignal) => {
      for (let i = 0; i < 40; i++) me.plugin.log.entry({ path: `new${String(i)}.md` } as never);
      during = me.plugin.getStatusView().label;
      return sync(signal);
    });
    await me.plugin.syncNow("manual");
    expect(during).toContain("40");
  });
});
