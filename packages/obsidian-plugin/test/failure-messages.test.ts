// ADR-0073: a failed sync and a rejected ticket say what happened in the
// interface's language, not as a raw "SyncError: …" (audit №4, B13). The raw
// text still goes to the log.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncError, type SyncErrorCode } from "@syncrypt/core";
import { MemoryStorage } from "@syncrypt/core/testing";

import { EN_STRINGS, stringsFor } from "../src/i18n.js";
import { syncFailureMessage, ticketFailureMessage } from "../src/unlock-error.js";
import { Notice, resetStub } from "./support/obsidian-stub.js";
import {
  importTicket,
  makeDevice,
  PASS,
  S3_DATA,
  settle,
  unlock,
  World,
} from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const T = EN_STRINGS;
const err = (code: SyncErrorCode): SyncError => new SyncError(code, "raw internals");

describe("syncFailureMessage", () => {
  it.each([
    ["StorageTransient", T.unlockModal.storageUnreachable],
    ["StorageRateLimited", T.unlockModal.storageUnreachable],
    ["StorageNotFound", T.unlockModal.storageUnreachable],
    ["StorageUnauthorized", T.unlockModal.storageUnauthorized],
    ["CryptoAuthError", T.notices.syncNotAuthentic],
    ["ManifestCorrupt", T.notices.syncManifestRefused],
  ] as const)("%s", (code, expected) => {
    expect(syncFailureMessage(err(code), T)).toBe(expected);
  });

  it("anything else keeps its detail, labelled", () => {
    expect(syncFailureMessage(new Error("disk"), T)).toBe(T.notices.commandFailedDetail("Error: disk"));
  });
});

describe("ticketFailureMessage", () => {
  it("a ticket that does not open names both causes", () => {
    expect(ticketFailureMessage(err("CryptoAuthError"), T)).toBe(T.notices.ticketDidNotOpen);
  });
  it("anything else keeps its detail", () => {
    expect(ticketFailureMessage(new Error("disk full"), T)).toBe(
      T.notices.commandFailedDetail("Error: disk full"),
    );
  });
});

describe("in the plugin", () => {
  it("a failed sync in a Russian interface shows no raw English error", async () => {
    class Down extends MemoryStorage {
      down = false;
      override async get(key: string): Promise<Uint8Array> {
        if (this.down) throw new SyncError("StorageTransient", "S3 GET: network error (raw)");
        return super.get(key);
      }
    }
    const world = new World(() => new Down());
    const me = await makeDevice(world, { ...S3_DATA, language: "ru", autoSync: { enabled: false } });
    me.adapter.setFile("a.md", "a");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    (world.store("s3:https://s3.example.com/notes") as Down).down = true;
    await me.plugin.syncNow("manual");
    const ru = stringsFor("ru");
    expect(Notice.shown).toContain(ru.notices.syncFailed(ru.unlockModal.storageUnreachable));
    expect(Notice.shown.join("\n")).not.toContain("SyncError");
    // The log keeps the raw detail for whoever reads it.
    expect(me.plugin.log.all().some((l) => (l.text ?? "").includes("network error (raw)"))).toBe(
      true,
    );
  });

  it("a pasted ticket that does not open says so in words", async () => {
    const me = await makeDevice(new World(), { ...S3_DATA, autoSync: { enabled: false } });
    await importTicket(me, "c3luY3J5cHQ=", PASS); // not a ticket
    expect(Notice.shown).toContain(T.notices.ticketRejected(T.notices.ticketDidNotOpen));
  });
});
