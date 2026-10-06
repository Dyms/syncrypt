// Review2 F1: Share connection seals an UNCHECKED passphrase when the storage
// is unreachable. passphraseIsDefinitelyWrong() turns every error other than
// NothingToCheck/KdfUnaffordable into `isSyncError(e, "CryptoAuthError")`,
// i.e. "not wrong" for StorageTransient — so the Q2 fix (ADR-0081 rule 4) is
// bypassed by a network blip at Share time. The receiving device takes the
// ticket as confirmed (ADR-0078) and publishes the vault's first generation
// under the typo; the sharer is locked out of its own vault.

import { beforeEach, describe, expect, it } from "vitest";

import { SyncError } from "@syncrypt/core";
import { MemoryStorage } from "@syncrypt/core/testing";

import { EN_STRINGS } from "../../src/i18n.js";
import { ShareConnectionModal } from "../../src/ticket-modals.js";
import { UnusablePrefix } from "../../src/unlock-error.js";
import { resetStub, Setting, type FakeEl } from "../support/obsidian-stub.js";
import {
  importTicket,
  mainStore,
  makeDevice,
  PASS,
  S3_DATA,
  settle,
  unlock,
  World,
} from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

class Flaky extends MemoryStorage {
  offline = false;
  private gate(): void {
    if (this.offline) throw new SyncError("StorageTransient", "offline");
  }
  override get(key: string) {
    if (this.offline) return Promise.reject(new SyncError("StorageTransient", "offline"));
    return super.get(key);
  }
  override stat(key: string) {
    if (this.offline) return Promise.reject(new SyncError("StorageTransient", "offline"));
    return super.stat(key);
  }
  override async *list(prefix: string) {
    this.gate();
    yield* super.list(prefix);
  }
}

const TYPO = "plugin harness passphrasf";

describe("F1: Share while the storage is unreachable", () => {
  it("does not answer 'not wrong' for a passphrase it could not check", async () => {
    const world = new World(() => new Flaky());
    const a = await makeDevice(world, { ...S3_DATA, deviceId: "dev-a", autoSync: { enabled: false } });
    await unlock(a.plugin, PASS, true); // created, nothing published yet
    await settle(a.plugin);
    (mainStore(world) as Flaky).offline = true;
    // Should reject (unchecked) — like NothingToCheck — never resolve `false`.
    await expect(a.plugin.passphraseIsWrong(TYPO)).rejects.toBeDefined();
  });

  it("end to end: the typo is sealed, the receiver publishes under it, the sharer is locked out", async () => {
    const world = new World(() => new Flaky());
    const a = await makeDevice(world, { ...S3_DATA, deviceId: "dev-a", autoSync: { enabled: false } });
    await unlock(a.plugin, PASS, true);
    await settle(a.plugin);
    const store = mainStore(world) as Flaky;
    store.offline = true;

    const modal = new ShareConnectionModal(a.plugin.app, a.plugin);
    modal.open();
    const field = Setting.rows.find((r) => r.name === EN_STRINGS.shareModal.passphrase)?.texts[0];
    if (field === undefined) throw new Error("no passphrase field");
    await field.type(TYPO);
    const content = (modal as unknown as { contentEl: FakeEl }).contentEl;
    content.button(EN_STRINGS.shareModal.generate).click();
    let area: FakeEl | undefined;
    for (let i = 0; i < 300 && area === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
      area = content.all().find((e) => e.tag === "textarea");
    }
    store.offline = false;
    // Expected: no ticket. Actual: a ticket sealed with the unchecked typo.
    if (area === undefined) return; // fixed: nothing sealed

    const b = await makeDevice(world, { deviceId: "dev-b", autoSync: { enabled: false } });
    b.adapter.setFile("b.md", "from b");
    await importTicket(b, area.value, TYPO);
    await settle(b.plugin);
    expect(store.keys().some((k) => k.includes("manifests"))).toBe(true);

    // The sharer, with its real passphrase, can no longer open its own vault.
    a.adapter.setFile("a.md", "from a");
    await a.plugin.syncNow("manual");
    await settle(a.plugin);
    // Expected: A syncs its vault. Actual: the vault's manifest is under B's typo.
    expect(await a.plugin.passphraseIsWrong(PASS), "sharer's real passphrase no longer opens its vault").toBe(false);
  });
});

// The same hole on R4's path: S3's client refuses an unsafe key with
// StorageTransient (providers/s3/src/client.ts), so on a beta.12 vault whose
// S3 prefix is "/notes" — kept as stored since ADR-0081 — every Share check
// answers "not wrong" without checking anything.
class S3Like extends MemoryStorage {
  private unsafe(key: string): boolean {
    return key.startsWith("/") || key.includes("//");
  }
  override get(key: string) {
    if (this.unsafe(key)) return Promise.reject(new SyncError("StorageTransient", `S3: refusing unsafe key "${key}"`));
    return super.get(key);
  }
  override stat(key: string) {
    if (this.unsafe(key)) return Promise.reject(new SyncError("StorageTransient", `S3: refusing unsafe key "${key}"`));
    return super.stat(key);
  }
  override async *list(prefix: string) {
    if (this.unsafe(prefix)) throw new SyncError("StorageTransient", `S3: refusing unsafe key "${prefix}"`);
    yield* super.list(prefix);
  }
}

describe("F1b: Share on a legacy S3 prefix with an empty segment", () => {
  it("does not answer 'not wrong' for a passphrase it could not check", async () => {
    const world = new World(() => new S3Like());
    const a = await makeDevice(world, {
      ...S3_DATA,
      s3: { ...S3_DATA.s3, prefix: "/notes" },
      deviceId: "dev-a",
      autoSync: { enabled: false },
    });
    expect(a.plugin.settings.s3.prefix).toBe("/notes"); // kept as stored (R4)
    // Said as what it is — the prefix — not as "storage unreachable" (ADR-0082).
    await expect(a.plugin.passphraseIsWrong("anything at all")).rejects.toBeInstanceOf(UnusablePrefix);
  });
});
