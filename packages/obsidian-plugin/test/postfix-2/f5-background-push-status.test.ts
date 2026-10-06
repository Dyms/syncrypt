// Review2 F5 (status honesty, new in 61e7329): the background push now goes
// through syncNow → finishReport(pushed), which REPLACES conflictPaths with the
// push report's (empty) list and sets lastOutcome/lastSyncAt as if a sync had
// completed. Switching away from the app once (mobile visibilitychange) wipes
// the "N conflicts — merge <path>" status the last real sync reported.

import { beforeEach, describe, expect, it } from "vitest";

import { resetStub } from "../support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, World } from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

describe("F5: background push and the conflict status", () => {
  it("does not forget the conflicts the last sync reported", async () => {
    const world = new World();
    const auto = { autoSync: { enabled: false } };
    const a = await makeDevice(world, { ...S3_DATA, ...auto, deviceId: "dev-a" });
    a.adapter.setFile("n.md", "base");
    await unlock(a.plugin, PASS, true);
    await settle(a.plugin);
    const b = await makeDevice(world, { ...S3_DATA, ...auto, deviceId: "dev-b" });
    await unlock(b.plugin, PASS);
    await settle(b.plugin);
    a.adapter.setFile("n.md", "edit on a");
    await a.plugin.syncNow("manual");
    b.adapter.setFile("n.md", "edit on b");
    await b.plugin.syncNow("manual");
    const priv = b.plugin as unknown as { conflictPaths: string[] };
    expect(priv.conflictPaths.length).toBeGreaterThan(0);
    await b.plugin.syncNow("background"); // app to background
    expect(priv.conflictPaths.length, "conflict status wiped by a background push").toBeGreaterThan(0);
  });
});
