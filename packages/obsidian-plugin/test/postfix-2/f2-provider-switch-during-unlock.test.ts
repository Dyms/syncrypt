// Review2 F2: Q6 (ADR-0081) bumps `storageEpoch` in storageSettingsChanged()
// and replaceSettings(), but the provider dropdown in the settings tab calls
// neither: it saves and locks only `if (isUnlocked())`. A switch while an
// unlock derives keys leaves the engine on S3 while the settings (and status,
// Share, the tab) say WebDAV — the exact Q6 defect, through the provider row.

import { beforeEach, describe, expect, it } from "vitest";

import { EN_STRINGS } from "../../src/i18n.js";
import { resetStub } from "../support/obsidian-stub.js";
import {
  makeDevice,
  PASS,
  renderTab,
  row,
  S3_DATA,
  settle,
  unlock,
  World,
} from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const WITH_DAV = {
  ...S3_DATA,
  webdav: { url: "https://dav.example.com/dav", username: "u", password: "p", prefix: "vaults/main" },
  autoSync: { enabled: false },
};

describe("F2: provider switched while an unlock derives keys", () => {
  it("is refused like any other storage edit (Q6)", async () => {
    const world = new World();
    const seed = await makeDevice(world, { ...WITH_DAV, deviceId: "dev-seed" });
    seed.adapter.setFile("a.md", "a");
    await unlock(seed.plugin, PASS, true);
    await settle(seed.plugin);

    const me = await makeDevice(world, { ...WITH_DAV, deviceId: "dev-me" });
    renderTab(me);
    const dropdown = row(EN_STRINGS.settings.provider).dropdowns[0];
    if (dropdown === undefined) throw new Error("no provider dropdown");
    const p = me.plugin as unknown as { openStorage(): Promise<unknown> };
    const orig = p.openStorage.bind(me.plugin);
    let edited = false;
    p.openStorage = async () => {
      const s = await orig();
      if (!edited) {
        edited = true;
        setTimeout(() => void dropdown.pick("webdav"), 0); // while Argon2id runs
      }
      return s;
    };
    await unlock(me.plugin, PASS).catch(() => undefined);
    await settle(me.plugin);
    expect(me.plugin.settings.provider).toBe("webdav");
    const onS3 = me.plugin.isUnlocked();
    // Expected: locked (LocationChanged). Actual: unlocked, engine on S3, settings on WebDAV.
    expect(onS3, "engine left on S3 under WebDAV settings").toBe(false);
  });
});
