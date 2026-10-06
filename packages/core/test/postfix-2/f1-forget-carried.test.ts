// F1 (regression in d0e7fe1): forgetPaths keeps the base entry of a path this
// device CARRIES (changed: new Set()), so another device's independent file at
// that path is later downloaded OVER this device's file as if it were an edit.
// Before d0e7fe1 the base dropped the entry and the same sequence was a
// conflict with both versions kept.
import { describe, expect, it } from "vitest";

import { createSyncEngine } from "../../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../../src/testing/index.js";

function dev(storage: MemoryStorage, id: string, vault: MemoryVault) {
  return createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock: new FixedClock(),
    log: new MemoryLog(),
    state: new MemoryStateStore(),
    deviceId: id,
    storagePrefix: "",
  });
}

describe("F1: forgetting a path this device carries", () => {
  it("does not let another device's independent file overwrite this device's copy", async () => {
    const storage = new MemoryStorage();
    const aVault = new MemoryVault();
    const a = dev(storage, "desktop", aVault);
    aVault.setFile("plan.md", "desktop's plan");
    await a.sync();

    // The engine API documents forgetting a carried path as harmless: "a
    // device that still carries such a path re-adds it on its next push".
    const r = await a.forgetPaths(["plan.md"]);
    expect(r.forgotten).toEqual(["plan.md"]);

    // Before the desktop's next push, a new device publishes its OWN plan.md.
    const bVault = new MemoryVault();
    const b = dev(storage, "laptop", bVault);
    bVault.setFile("plan.md", "laptop's unrelated plan");
    await b.sync();

    await a.sync();

    const everything = [
      ...aVault.paths().map((p) => aVault.getText(p)),
      ...aVault.trashed.map((t) => new TextDecoder().decode(t.data)),
    ];
    // On HEAD: plan.md is silently replaced, no copy, nothing in trash.
    expect(everything).toContain("desktop's plan");
  });
});
