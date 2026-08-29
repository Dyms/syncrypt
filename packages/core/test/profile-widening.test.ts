// A device whose profile GROWS must download what it did not carry before —
// never report it as a local deletion. ADR-0025.
//
// ADR-0022 fixed the constant-profile case: a path outside this device's
// profile is not "deleted here". But the base manifest still recorded those
// paths, and the base is supposed to mean "what THIS device last synced".
// The moment the profile widened, "in base, absent locally" read as a
// deletion and tombstoned the file for every device. The shared config-sync
// profile (ADR-0024) makes widening an ordinary, automatic event, so this is
// pinned down here.

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

/** A vault that carries only part of what is on disk — a sync profile. */
class ProfiledVault extends MemoryVault {
  constructor(public carries: (path: VaultPath) => boolean) {
    super();
  }
  override async *list(): AsyncIterable<VaultPath> {
    for await (const path of super.list()) {
      if (this.carries(path)) yield path;
    }
  }
  // Not an override: MemoryVault has no profile — VaultPort.syncable is optional.
  syncable(path: VaultPath): boolean {
    return this.carries(path);
  }
}

function engineFor(
  storage: MemoryStorage,
  deviceId: string,
  vault: MemoryVault,
  state: MemoryStateStore,
): SyncEngine {
  return createSyncEngine({
    storage,
    vault,
    crypto: new IdentityCrypto(),
    clock: new FixedClock(),
    log: new MemoryLog(),
    state,
    deviceId,
    storagePrefix: "",
  });
}

describe("widening a device's profile", () => {
  it("downloads the newly covered files instead of deleting them for everyone", async () => {
    const storage = new MemoryStorage();
    const desktopState = new MemoryStateStore();
    const desktop = new MemoryVault();
    const desktopEngine = engineFor(storage, "desktop", desktop, desktopState);

    // The phone saves space: no PDFs.
    const phone = new ProfiledVault((p) => !p.endsWith(".pdf"));
    const phoneState = new MemoryStateStore();
    const narrow = engineFor(storage, "phone", phone, phoneState);

    desktop.setFile("note.md", "hello");
    desktop.setFile("papers/big.pdf", "PDF BYTES");
    await desktopEngine.sync();
    await narrow.sync();
    expect(phone.getText("note.md")).toBe("hello");
    expect(phone.getText("papers/big.pdf")).toBeNull(); // not carried here

    // The user turns PDFs back on. Same vault, same state, new engine —
    // exactly what the plugin does when the profile changes.
    phone.carries = () => true;
    const widened = engineFor(storage, "phone", phone, phoneState);
    const report = await widened.sync();

    expect(report.entries.map((e) => e.kind)).not.toContain("delete-remote");
    expect(phone.getText("papers/big.pdf")).toBe("PDF BYTES");

    // …and the desktop still has it after the phone's sync reaches it.
    await desktopEngine.sync();
    expect(desktop.getText("papers/big.pdf")).toBe("PDF BYTES");
  });

  it("a base written by an older version is filtered when it is loaded", async () => {
    const storage = new MemoryStorage();
    const desktop = new MemoryVault();
    const desktopEngine = engineFor(storage, "desktop", desktop, new MemoryStateStore());
    desktop.setFile("note.md", "hello");
    desktop.setFile("papers/big.pdf", "PDF BYTES");
    await desktopEngine.sync();

    // A pre-ADR-0025 blob: the base holds the WHOLE manifest, including the
    // file this device does not carry.
    const reader = new MemoryStateStore();
    await engineFor(storage, "reader", new MemoryVault(), reader).pull();
    const wholeBase = (
      JSON.parse(new TextDecoder().decode((await reader.load()) ?? new Uint8Array())) as {
        base: unknown;
      }
    ).base;
    expect(JSON.stringify(wholeBase)).toContain("papers/big.pdf");

    const legacyState = new MemoryStateStore();
    await legacyState.save(
      new TextEncoder().encode(JSON.stringify({ version: 1, base: wholeBase })),
    );

    // The upgraded phone opens that blob under the profile that wrote it (the
    // profile can only change while the plugin is running), so the lie is
    // dropped on the way in…
    const phone = new ProfiledVault((p) => !p.endsWith(".pdf"));
    phone.setFile("note.md", "hello");
    const upgraded = engineFor(storage, "phone", phone, legacyState);
    await upgraded.sync();

    // …and widening afterwards downloads rather than deletes.
    phone.carries = () => true;
    await engineFor(storage, "phone", phone, legacyState).sync();
    expect(phone.getText("papers/big.pdf")).toBe("PDF BYTES");
    await desktopEngine.sync();
    expect(desktop.getText("papers/big.pdf")).toBe("PDF BYTES");
  });

  it("narrowing still leaves the others alone (ADR-0022 stays true)", async () => {
    const storage = new MemoryStorage();
    const desktop = new MemoryVault();
    const desktopEngine = engineFor(storage, "desktop", desktop, new MemoryStateStore());
    const phone = new ProfiledVault(() => true);
    const phoneState = new MemoryStateStore();

    desktop.setFile("note.md", "hello");
    desktop.setFile("papers/big.pdf", "PDF BYTES");
    await desktopEngine.sync();
    await engineFor(storage, "phone", phone, phoneState).sync();
    expect(phone.getText("papers/big.pdf")).toBe("PDF BYTES");

    phone.carries = (p) => !p.endsWith(".pdf");
    const narrowed = engineFor(storage, "phone", phone, phoneState);
    await narrowed.sync();
    await narrowed.sync();
    await desktopEngine.sync();

    expect(desktop.getText("papers/big.pdf")).toBe("PDF BYTES");
  });
});
