// ADR-0007 says a case-only collision is a conflict, never a dupe and never a
// silent overwrite. The planner enforced that only against paths the scan had
// already seen, so two manifest paths that differ by case only — with neither
// present locally — were two plain creations, and on a case-insensitive
// filesystem the second landed on the first.

import { describe, expect, it } from "vitest";

import { createSyncEngine, type SyncEngine, type VaultPath } from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

/** A vault on a filesystem that folds case, the way macOS and Windows do. */
class CaseInsensitiveVault extends MemoryVault {
  private readonly real = new Map<string, VaultPath>();

  private fold(p: VaultPath): VaultPath {
    const k = p.toLowerCase();
    const existing = this.real.get(k);
    if (existing !== undefined) return existing;
    this.real.set(k, p);
    return p;
  }

  override read(p: VaultPath): Promise<Uint8Array> {
    return super.read(this.fold(p));
  }
  override write(p: VaultPath, data: Uint8Array): Promise<void> {
    return super.write(this.fold(p), data);
  }
  override stat(p: VaultPath): Promise<{ size: number; mtime: number } | null> {
    return super.stat(this.fold(p));
  }
  override trash(p: VaultPath): Promise<void> {
    return super.trash(this.fold(p));
  }
}

function device(
  storage: MemoryStorage,
  id: string,
  vault: MemoryVault,
): { engine: SyncEngine; vault: MemoryVault; log: MemoryLog } {
  const log = new MemoryLog();
  return {
    engine: createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock: new FixedClock(),
      log,
      state: new MemoryStateStore(),
      deviceId: id,
      storagePrefix: "",
    }),
    vault,
    log,
  };
}

/** A vault holding two paths that differ only by case, published to storage. */
async function vaultWithBothCases(storage: MemoryStorage): Promise<void> {
  const sensitive = device(storage, "linux", new MemoryVault());
  sensitive.vault.setFile("Note.md", "UPPER content");
  sensitive.vault.setFile("note.md", "lower content, a different length");
  await sensitive.engine.sync();
}

describe("two remote paths that differ only by case", () => {
  it("BOTH SURVIVE ON A CASE-INSENSITIVE DEVICE, ONE AS A CONFLICTED COPY", async () => {
    const storage = new MemoryStorage();
    await vaultWithBothCases(storage);

    const mac = device(storage, "mac", new CaseInsensitiveVault());
    const report = await mac.engine.sync();

    // Neither body may be lost: whichever path the filesystem folded onto the
    // other is materialized alongside it, never over it (ADR-0012).
    const bodies = mac.vault.paths().map((p) => mac.vault.getText(p));
    expect(bodies).toContain("UPPER content");
    expect(bodies).toContain("lower content, a different length");
    expect(report.conflicts).toHaveLength(1);
    expect(mac.vault.paths().some((p) => p.includes("conflicted copy"))).toBe(true);
  });

  it("a case-sensitive device still gets two ordinary files and no conflict", async () => {
    const storage = new MemoryStorage();
    await vaultWithBothCases(storage);

    const linux = device(storage, "linux-2", new MemoryVault());
    const report = await linux.engine.sync();

    expect(report.conflicts).toEqual([]);
    expect(linux.vault.paths().sort()).toEqual(["Note.md", "note.md"]);
    expect(linux.vault.getText("Note.md")).toBe("UPPER content");
    expect(linux.vault.getText("note.md")).toBe(
      "lower content, a different length",
    );
  });
});

describe("a file that appears locally between the scan and the write", () => {
  it("is not overwritten by the creation the planner had decided on", async () => {
    const storage = new MemoryStorage();
    const author = device(storage, "author", new MemoryVault());
    author.vault.setFile("shared.md", "the published version");
    await author.engine.sync();

    const other = device(storage, "other", new MemoryVault());
    // The scan runs against an empty vault; the user creates the file while
    // the download is in flight.
    const vault = other.vault;
    const realList = vault.list.bind(vault);
    let created = false;
    vault.list = async function* () {
      for await (const p of realList()) yield p;
      if (!created) {
        created = true;
        vault.setFile("shared.md", "what I was typing just now");
      }
    };

    const report = await other.engine.sync();

    expect(vault.getText("shared.md")).toBe("what I was typing just now");
    expect(report.conflicts).toEqual(["shared.md"]);
    const copy = vault.paths().find((p) => p.includes("conflicted copy"));
    expect(copy).toBeDefined();
    expect(vault.getText(copy ?? "")).toBe("the published version");
  });

  it("an ordinary update of a file the scan DID see still overwrites in place", async () => {
    const storage = new MemoryStorage();
    const a = device(storage, "a", new MemoryVault());
    a.vault.setFile("note.md", "v1");
    await a.engine.sync();

    const b = device(storage, "b", new MemoryVault());
    await b.engine.sync();
    expect(b.vault.getText("note.md")).toBe("v1");

    a.vault.now += 10;
    a.vault.setFile("note.md", "v2, which is longer");
    await a.engine.sync();

    const report = await b.engine.sync();
    expect(report.conflicts).toEqual([]);
    expect(b.vault.getText("note.md")).toBe("v2, which is longer");
    expect(b.vault.paths()).toEqual(["note.md"]); // no stray conflicted copy
  });
});
