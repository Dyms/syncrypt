// ADR-0055. ADR-0027 called forgetting non-destructive, and gave the reason:
// a device that still carries the path re-adds it. True — and silent about the
// case the command is aimed at, an entry NO device carries any more, where the
// bucket holds the only copy. Once ADR-0030 could delete unreferenced objects,
// forget-then-reclaim destroyed exactly those files.

import { describe, expect, it } from "vitest";

import {
  OBJECTS_PREFIX,
  createSyncEngine,
  parseManifest,
  serializeManifest,
  type Manifest,
  type SyncEngine,
  type VaultPath,
} from "../src/index.js";
import {
  FixedClock,
  IdentityCrypto,
  MemoryLog,
  MemoryStateStore,
  MemoryStorage,
  MemoryVault,
} from "../src/testing/index.js";

const DAY = 24 * 60 * 60;
const NOW = 1_000_000;

/** A vault whose profile does not carry PDFs, like a phone's (ADR-0022). */
class ProfiledVault extends MemoryVault {
  constructor(private readonly carries: (p: VaultPath) => boolean) {
    super();
  }
  override async *list(): AsyncIterable<VaultPath> {
    for await (const p of super.list()) if (this.carries(p)) yield p;
  }
  syncable(p: VaultPath): boolean {
    return this.carries(p);
  }
}

function device(
  storage: MemoryStorage,
  id: string,
  clock: FixedClock,
  vault: MemoryVault,
): { engine: SyncEngine; vault: MemoryVault; log: MemoryLog } {
  const log = new MemoryLog();
  return {
    engine: createSyncEngine({
      storage,
      vault,
      crypto: new IdentityCrypto(),
      clock,
      log,
      state: new MemoryStateStore(),
      deviceId: id,
      storagePrefix: "",
      safeSync: { versionsToKeep: 1, generationsToKeep: 1, reclaimGraceSeconds: DAY },
    }),
    vault,
    log,
  };
}

const objects = (storage: MemoryStorage): string[] =>
  storage.keys().filter((k) => k.startsWith(OBJECTS_PREFIX)).sort();

async function topManifest(storage: MemoryStorage): Promise<Manifest> {
  const key = storage.keys().filter((k) => k.startsWith("manifests/")).sort().reverse()[0] ?? "";
  return parseManifest(await new IdentityCrypto().decrypt("manifest", await storage.get(key)));
}

/**
 * A laptop publishes a PDF and is never seen again; a phone that does not
 * carry PDFs is the only device left. Storage holds the only copy.
 */
async function vaultWithAnOrphan(storage: MemoryStorage, clock: FixedClock) {
  const laptop = device(storage, "laptop", clock, new MemoryVault());
  laptop.vault.setFile("note.md", "kept");
  laptop.vault.setFile("papers/big.pdf", "THE ONLY COPY OF THIS PDF");
  await laptop.engine.sync();

  const phone = device(
    storage,
    "phone",
    clock,
    new ProfiledVault((p) => !p.endsWith(".pdf")),
  );
  await phone.engine.sync();
  return phone;
}

describe("forgetting keeps the stored copy", () => {
  it("THE ONLY COPY SURVIVES FORGET PLUS TWO RECLAIMS", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock(NOW);
    const phone = await vaultWithAnOrphan(storage, clock);

    expect((await phone.engine.listUncarried()).map((c) => c.path)).toEqual([
      "papers/big.pdf",
    ]);
    const before = objects(storage);
    expect(before).toHaveLength(2);

    await phone.engine.forgetPaths(["papers/big.pdf"]);

    // The whole reclamation cycle, twice, a day apart — the flow the UI
    // recommends, and the one that used to destroy the file.
    await phone.engine.reclaimStorage();
    clock.advance(2 * DAY);
    const swept = await phone.engine.reclaimStorage();

    expect(swept.deleted).toEqual([]);
    expect(objects(storage)).toEqual(before);
  });

  it("the entry is gone from files, and its object is named in forgotten", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock(NOW);
    const phone = await vaultWithAnOrphan(storage, clock);

    const wasLive = (await topManifest(storage)).files["papers/big.pdf"]?.objectKey;
    expect(wasLive).toBeDefined();

    await phone.engine.forgetPaths(["papers/big.pdf"]);

    const m = await topManifest(storage);
    expect(m.files["papers/big.pdf"]).toBeUndefined(); // the manifest is smaller
    expect(m.forgotten).toEqual([wasLive]); // and the bytes are still spoken for
  });

  it("a device that still carries the path puts it back, as ADR-0027 promised", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock(NOW);
    const laptop = device(storage, "laptop", clock, new MemoryVault());
    laptop.vault.setFile("papers/big.pdf", "still on the laptop");
    await laptop.engine.sync();

    const phone = device(
      storage,
      "phone",
      clock,
      new ProfiledVault((p) => !p.endsWith(".pdf")),
    );
    await phone.engine.sync();
    await phone.engine.forgetPaths(["papers/big.pdf"]);

    await laptop.engine.sync();
    expect((await topManifest(storage)).files["papers/big.pdf"]).toBeDefined();
    expect(laptop.vault.trashed).toEqual([]);
  });

  it("the forgotten list rides along on an ordinary push", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock(NOW);
    const phone = await vaultWithAnOrphan(storage, clock);
    await phone.engine.forgetPaths(["papers/big.pdf"]);
    const kept = (await topManifest(storage)).forgotten;
    expect(kept).toHaveLength(1);

    phone.vault.now += 10;
    phone.vault.setFile("note.md", "an ordinary edit, of another length");
    await phone.engine.sync();

    // A push has no opinion about what was forgotten; dropping the list here
    // would hand those objects to the next reclamation.
    expect((await topManifest(storage)).forgotten).toEqual(kept);
  });

  it("forgetting records the writer, so peers do not report an older client", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock(NOW);
    const phone = device(
      storage,
      "phone",
      clock,
      new ProfiledVault((p) => !p.endsWith(".pdf")),
    );
    const laptop = createSyncEngine({
      storage,
      vault: (() => {
        const v = new MemoryVault();
        v.setFile("papers/big.pdf", "x");
        return v;
      })(),
      crypto: new IdentityCrypto(),
      clock,
      log: new MemoryLog(),
      state: new MemoryStateStore(),
      deviceId: "laptop",
      storagePrefix: "",
      clientVersion: "1.0.0",
    });
    await laptop.sync();
    await phone.engine.sync();
    await phone.engine.forgetPaths(["papers/big.pdf"]);
    expect((await topManifest(storage)).writer).toBeUndefined(); // phone has no version set

    // …and with one configured, it is recorded (ADR-0036).
    const versioned = createSyncEngine({
      storage,
      vault: new ProfiledVault((p) => !p.endsWith(".pdf")),
      crypto: new IdentityCrypto(),
      clock,
      log: new MemoryLog(),
      state: new MemoryStateStore(),
      deviceId: "phone-2",
      storagePrefix: "",
      clientVersion: "1.0.0",
    });
    await versioned.sync();
    const laptop2 = createSyncEngine({
      storage,
      vault: (() => {
        const v = new MemoryVault();
        v.setFile("papers/other.pdf", "y");
        return v;
      })(),
      crypto: new IdentityCrypto(),
      clock,
      log: new MemoryLog(),
      state: new MemoryStateStore(),
      deviceId: "laptop-2",
      storagePrefix: "",
      clientVersion: "1.0.0",
    });
    await laptop2.sync();
    await versioned.sync();
    await versioned.forgetPaths(["papers/other.pdf"]);
    expect((await topManifest(storage)).writer).toBe("1.0.0");
  });
});

describe("releasing is the second, deliberate half", () => {
  it("after it, the object is ordinary garbage and reclamation takes it", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock(NOW);
    const phone = await vaultWithAnOrphan(storage, clock);
    await phone.engine.forgetPaths(["papers/big.pdf"]);

    const released = await phone.engine.releaseForgotten();
    expect(released.released).toBe(1);
    expect((await topManifest(storage)).forgotten).toBeUndefined();
    expect(phone.log.notices.some((n) => n.code === "forgotten-objects-released")).toBe(true);

    // Still not deleted by the release itself — that is reclamation's job,
    // grace window and re-check and all.
    expect(objects(storage)).toHaveLength(2);
    await phone.engine.reclaimStorage();
    expect(objects(storage)).toHaveLength(2);
    clock.advance(2 * DAY);
    const swept = await phone.engine.reclaimStorage();
    expect(swept.deleted).toHaveLength(1);
    expect(objects(storage)).toHaveLength(1);
  });

  it("releasing nothing publishes nothing", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock(NOW);
    const phone = await vaultWithAnOrphan(storage, clock);
    const before = storage.keys().filter((k) => k.startsWith("manifests/")).length;

    const result = await phone.engine.releaseForgotten();

    expect(result).toEqual({ released: 0, generation: null });
    expect(storage.keys().filter((k) => k.startsWith("manifests/")).length).toBe(before);
  });

  it("status() reports what is being kept, so a client can explain the space", async () => {
    const storage = new MemoryStorage();
    const clock = new FixedClock(NOW);
    const phone = await vaultWithAnOrphan(storage, clock);
    expect((await phone.engine.status()).forgottenObjects).toBe(0);

    await phone.engine.forgetPaths(["papers/big.pdf"]);
    expect((await phone.engine.status()).forgottenObjects).toBe(1);

    await phone.engine.releaseForgotten();
    expect((await phone.engine.status()).forgottenObjects).toBe(0);
  });
});

describe("the forgotten list is untrusted input like every other name", () => {
  const base = (over: Partial<Manifest> = {}): Manifest => ({
    version: 1,
    generation: 4,
    device: "dev-1",
    updatedAt: 1000,
    files: {},
    tombstones: {},
    ...over,
  });

  it("round-trips, sorted and deduplicated", () => {
    const m = base({ forgotten: [`${OBJECTS_PREFIX}bb`, `${OBJECTS_PREFIX}aa`] });
    const back = parseManifest(serializeManifest(m));
    expect(back.forgotten).toEqual([`${OBJECTS_PREFIX}aa`, `${OBJECTS_PREFIX}bb`]);

    const dupes = base({ forgotten: [`${OBJECTS_PREFIX}aa`, `${OBJECTS_PREFIX}aa`] });
    expect(parseManifest(serializeManifest(dupes)).forgotten).toEqual([
      `${OBJECTS_PREFIX}aa`,
    ]);
  });

  it("a key shaped like a path is refused, not kept", () => {
    // ADR-0044: it comes out of storage and goes back to the storage layer.
    for (const bad of [
      `${OBJECTS_PREFIX}../manifests/000000009-devA.json`,
      `${OBJECTS_PREFIX}./x`,
      `${OBJECTS_PREFIX}/x`,
      "",
    ]) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ ...base(), forgotten: [bad] }),
      );
      expect(() => parseManifest(bytes), bad).toThrow(/forgotten/);
    }
  });

  it("a non-array, or a non-string member, is corrupt", () => {
    for (const bad of ["nope", 7, [42], [null]]) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ ...base(), forgotten: bad }),
      );
      expect(() => parseManifest(bytes), JSON.stringify(bad)).toThrow(/forgotten/);
    }
  });

  it("an absent or empty list is simply absent", () => {
    expect(parseManifest(serializeManifest(base())).forgotten).toBeUndefined();
    expect(parseManifest(serializeManifest(base({ forgotten: [] }))).forgotten).toBeUndefined();
  });
});
