// F3 (pre-existing, adjacent to ADR-0080 P3): writeAndRemember stats the file
// AFTER writing it and records the DOWNLOADED hash under whatever size/mtime
// it finds. A save that lands between the write and that stat is recorded as
// the downloaded content: the scan never re-reads it, it is never uploaded,
// and the next remote change is downloaded over it with no copy.
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

class HookVault extends MemoryVault {
  afterWrite: ((path: VaultPath) => void) | null = null;
  // Returns what MemoryVault vouches for — the stat of the write itself. An
  // edit by the hook below comes after, with a later mtime (ADR-0082).
  override async write(path: VaultPath, data: Uint8Array): ReturnType<MemoryVault["write"]> {
    const written = await super.write(path, data);
    const f = this.afterWrite;
    this.afterWrite = null;
    f?.(path);
    return written;
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

describe("F3: a save between the engine's write and its stat", () => {
  it("is not recorded as the downloaded content", async () => {
    const storage = new MemoryStorage();
    const oneVault = new MemoryVault();
    const one = dev(storage, "one", oneVault);
    oneVault.setFile("note.md", "v1");
    await one.sync();
    const twoVault = new HookVault();
    const two = dev(storage, "two", twoVault);
    await two.sync();

    oneVault.now += 10;
    oneVault.setFile("note.md", "v2 from one");
    await one.sync();

    twoVault.afterWrite = (p) => {
      twoVault.now += 1;
      twoVault.setFile(p, "two's edit, saved right after the engine's write");
    };
    await two.sync();
    await two.sync(); // should upload two's edit

    oneVault.now += 10;
    oneVault.setFile("note.md", "v3 from one, much later");
    await one.sync();
    await two.sync();

    const all = [
      ...twoVault.paths().map((p) => twoVault.getText(p)),
      ...twoVault.trashed.map((t) => new TextDecoder().decode(t.data)),
      ...oneVault.paths().map((p) => oneVault.getText(p)),
    ];
    expect(all).toContain("two's edit, saved right after the engine's write");
  });
});
