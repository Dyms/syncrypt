// Device-enrollment flow (ADR-0020), headless: export → import applies every
// field; wrong passphrase leaves settings untouched; a fresh device with the
// imported settings + the passphrase reaches "connected" (engine over a mock
// provider).

import { describe, expect, it } from "vitest";

import { openSyncEngine } from "@syncrypt/sdk";
import { MemoryStateStore, MemoryStorage } from "@syncrypt/core/testing";
import {
  createConnectionTicket,
  openConnectionTicket,
  type ConnectionTicketInput,
} from "@syncrypt/crypto";

import { DEFAULT_PROFILE } from "../src/profile.js";
import { settingsComplete, withDefaults } from "../src/settings.js";
import { applyTicketToSettings, ticketIsCredsLess } from "../src/ticket-flow.js";
import { ObsidianVault } from "../src/vault-adapter.js";
import { MockDataAdapter } from "./mock-adapter.js";

const PASSPHRASE = "enrollment passphrase";
const CONNECTION: ConnectionTicketInput = {
  provider: "s3",
  endpoint: "https://s3.example.com",
  region: "eu-central-1",
  bucket: "vault-bucket",
  prefix: "vaults/main",
  forcePathStyle: true,
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "MACHINE-SECRET-KEY",
};

describe("ticket → settings flow", () => {
  it("import fills every connection field and completes the settings", async () => {
    const ticket = await createConnectionTicket(CONNECTION, PASSPHRASE);
    const payload = await openConnectionTicket(ticket, PASSPHRASE);

    const fresh = withDefaults(null);
    expect(settingsComplete(fresh)).toBe(false);
    const applied = applyTicketToSettings(fresh, payload);
    expect(applied.s3).toEqual({
      endpoint: CONNECTION.endpoint,
      region: CONNECTION.region,
      bucket: CONNECTION.bucket,
      prefix: CONNECTION.prefix,
      forcePathStyle: true,
      accessKeyId: CONNECTION.accessKeyId,
      secretAccessKey: CONNECTION.secretAccessKey,
    });
    expect(settingsComplete(applied)).toBe(true);
    expect(ticketIsCredsLess(payload)).toBe(false);
    // The original settings object is not mutated (fail-closed friendliness).
    expect(fresh.s3.bucket).toBe("");
  }, 30_000);

  it("wrong passphrase: open() throws and settings are never touched", async () => {
    const ticket = await createConnectionTicket(CONNECTION, PASSPHRASE);
    const fresh = withDefaults(null);
    await expect(openConnectionTicket(ticket, "wrong")).rejects.toMatchObject({
      code: "CryptoAuthError",
    });
    expect(settingsComplete(fresh)).toBe(false);
    expect(fresh.s3.accessKeyId).toBe("");
  }, 30_000);

  it("creds-less ticket flags manual credential entry", async () => {
    const { accessKeyId: _a, secretAccessKey: _s, ...configOnly } = CONNECTION;
    const payload = await openConnectionTicket(
      await createConnectionTicket(configOnly, PASSPHRASE),
      PASSPHRASE,
    );
    expect(ticketIsCredsLess(payload)).toBe(true);
    const applied = applyTicketToSettings(withDefaults(null), payload);
    expect(applied.s3.bucket).toBe(CONNECTION.bucket);
    expect(applied.s3.accessKeyId).toBe("");
    expect(settingsComplete(applied)).toBe(false); // must type keys manually
  }, 30_000);

  it("the enrolled device reaches 'connected' with just ticket + passphrase", async () => {
    // Storage stands in for the real bucket; the point is the FLOW: imported
    // settings + the one human secret produce a working engine.
    const storage = new MemoryStorage();
    const payload = await openConnectionTicket(
      await createConnectionTicket(CONNECTION, PASSPHRASE),
      PASSPHRASE,
    );
    const settings = applyTicketToSettings(withDefaults(null), payload);
    expect(settingsComplete(settings)).toBe(true);

    const adapter = new MockDataAdapter();
    adapter.folders.add(".obsidian");
    const engine = await openSyncEngine({
      storage,
      vault: new ObsidianVault(adapter, DEFAULT_PROFILE),
      passphrase: PASSPHRASE,
      deviceId: settings.deviceId,
      storagePrefix: settings.s3.prefix,
      state: new MemoryStateStore(),
      kdfDefaults: {
        kdf: "argon2id",
        version: 1,
        memoryKiB: 19456,
        iterations: 2,
        parallelism: 1,
      },
    });
    const status = await engine.status();
    expect(status.locked).toBe(false);
    expect((await engine.sync()).outcome).toBe("no-op"); // connected & clean
  }, 30_000);
});
