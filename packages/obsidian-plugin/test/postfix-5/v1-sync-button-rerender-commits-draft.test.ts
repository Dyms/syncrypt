// Fifth post-fix review (ADR-0085). Before it: failed.
// Review5 V1: the settings tab's "Sync now" button re-renders the tab when the
// sync it started ends (`await syncNow(); rerender()`), and since ADR-0082
// display() COMMITS every profile draft — saved and applied to the vault port.
// A manual sync takes as long as the vault needs; a person who starts typing a
// pattern meanwhile ("*" on the way to "*.pdf") gets the half pattern saved and
// live-applied the moment the sync ends, without ever leaving the field — the
// exact R5/F4 case ADR-0082 set out to close. The re-render also replaces the
// textarea, so the rest of the pattern is never typed into it.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EN_STRINGS } from "../../src/i18n.js";
import { resetStub, Setting } from "../support/obsidian-stub.js";
import {
  engineOf,
  field,
  makeDevice,
  PASS,
  renderTab,
  S3_DATA,
  saved,
  settle,
  unlock,
  World,
} from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const T = EN_STRINGS.settings;

describe("V1: the Sync now button's re-render commits a half-typed pattern", () => {
  it("does not save or apply a pattern whose field was never left", async () => {
    const world = new World();
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    me.adapter.setFile("todo.md", "t");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const engine = engineOf(me);
    const sync = engine.sync.bind(engine);
    renderTab(me);
    const syncRow = Setting.rows.find((r) => r.buttons.some((b) => b.buttonEl.text === T.syncNow));
    if (syncRow === undefined) throw new Error("no Sync now button");
    vi.spyOn(engine, "sync").mockImplementationOnce(async (signal) => {
      // While the sync the button started runs: typing, caret still in the field.
      await field(T.exclude).type("*");
      return sync(signal);
    });
    const button = syncRow.buttons.find((b) => b.buttonEl.text === T.syncNow);
    button?.buttonEl.click();
    await settle(me.plugin);
    await new Promise((r) => setTimeout(r, 50));
    const port = (me.plugin as unknown as { vaultPort: { syncable(p: string): boolean } }).vaultPort;
    const savedExclude = [...saved(me).profile.exclude];
    expect.soft(savedExclude, "half-typed '*' saved without leaving the field").not.toContain("*");
    expect.soft(port.syncable("todo.md"), "half-typed '*' applied to the vault port").toBe(true);
  });
});
