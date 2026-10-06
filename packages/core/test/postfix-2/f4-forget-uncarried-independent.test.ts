// F4 (pre-existing, ADR-0027/0055, not introduced by d0e7fe1): a phone
// forgets an entry it does not carry -- exactly what the "review manifest"
// dialog offers. A device that never had the path then publishes its own,
// unrelated file there (B,null,null -> upload). The desktop that still
// carries the forgotten version reads that as an EDIT of its file (A,A,B ->
// download) and overwrites it: no conflict copy, no trash, no history (forget
// dropped it); only the forgotten-objects list still names the ciphertext.
import { describe, expect, it } from "vitest";

import { createSyncEngine, type VaultPath } from "../../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../../src/testing/index.js";

class ProfiledVault extends MemoryVault {
  constructor(private readonly carries: (p: VaultPath) => boolean) {
    super();
  }
  override async *list(): AsyncIterable<VaultPath> {
    for await (const p of super.list()) if (this.carries(p)) yield p;
  }
  syncable(path: VaultPath): boolean {
    return this.carries(path);
  }
}

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

describe("F4: forgetting an uncarried entry that another device still carries", () => {
  it("does not let a third device's unrelated file overwrite the carrier's copy", async () => {
    const storage = new MemoryStorage();
    const deskVault = new MemoryVault();
    const desk = dev(storage, "desk", deskVault);
    deskVault.setFile("scan.pdf", "desk's scan");
    await desk.sync();

    const phoneVault = new ProfiledVault((p) => !p.endsWith(".pdf"));
    const phone = dev(storage, "phone", phoneVault);
    await phone.sync();
    const uncarried = await phone.listUncarried();
    await phone.forgetPaths(uncarried.map((u) => u.path));

    const laptopVault = new MemoryVault();
    const laptop = dev(storage, "laptop", laptopVault);
    laptopVault.setFile("scan.pdf", "laptop's different scan");
    await laptop.sync();

    await desk.sync();
    const all = [
      ...deskVault.paths().map((p) => deskVault.getText(p)),
      ...deskVault.trashed.map((t) => new TextDecoder().decode(t.data)),
      ...laptopVault.paths().map((p) => laptopVault.getText(p)),
    ];
    expect(all).toContain("desk's scan");
  });
});
