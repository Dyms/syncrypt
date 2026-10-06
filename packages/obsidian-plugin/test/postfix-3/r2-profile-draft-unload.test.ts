// Review3 R2: since ADR-0082 a profile edit stays a draft until the field is
// left (blur), the tab is hidden, or the tab re-renders. Unloading the plugin
// (update via BRAT, disable, quit) with the tab open and the caret still in
// the field does none of these: onunload() never commits the draft. Before
// ADR-0082 the edit was saved per keystroke.

import { beforeEach, describe, expect, it } from "vitest";

import { EN_STRINGS } from "../../src/i18n.js";
import { resetStub } from "../support/obsidian-stub.js";
import { field, makeDevice, renderTab, S3_DATA, saved, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

describe("R2: a profile edit in progress at unload", () => {
  it("is persisted", async () => {
    const world = new World();
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    renderTab(me);
    await field(EN_STRINGS.settings.exclude).type("private/**");
    me.plugin.onunload();
    await new Promise((r) => setTimeout(r, 50));
    expect(saved(me).profile.exclude, "typed exclude rule lost").toContain("private/**");
  });
});
