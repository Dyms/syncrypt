// Review2 F4: R5 (ADR-0081) stops applying the profile per keystroke, but
// syncNow()'s finally still runs applyLiveSettings() when `liveSettingsPending`
// is set — and that applies whatever is in settings.profile at that moment,
// half-typed or not. Any live-applied field touched during a sync (the Safe
// Sync numbers still call applyLiveSettings per keystroke) arms it; a pattern
// being typed when the sync ends then reaches the vault port without a blur.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EN_STRINGS } from "../../src/i18n.js";
import { resetStub } from "../support/obsidian-stub.js";
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
} from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const T = EN_STRINGS.settings;

describe("F4: a half-typed pattern applied at the end of a sync", () => {
  it("does not reach the vault port while the field is still being typed", async () => {
    const world = new World();
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    me.adapter.setFile("todo.md", "t");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const engine = engineOf(me);
    const sync = engine.sync.bind(engine);
    vi.spyOn(engine, "sync").mockImplementationOnce(async (signal) => {
      renderTab(me);
      await field(T.confirmationFloor).type("7"); // a live field, edited during the sync
      await field(T.exclude).type("*"); // then on the way to "*.pdf" — still typing, no blur
      return sync(signal);
    });
    await me.plugin.syncNow("manual");
    const port = (me.plugin as unknown as { vaultPort: { syncable(p: string): boolean } }).vaultPort;
    expect(port.syncable("todo.md"), "half-typed '*' applied without leaving the field").toBe(true);
  });
});
