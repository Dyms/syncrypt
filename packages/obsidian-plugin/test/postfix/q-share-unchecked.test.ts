// Post-fix review Q2 (ADR-0081): ADR-0078 says "a ticket's passphrase counts
// as confirmed", because Share connection checks it. On a vault with nothing
// published the Share check cannot tell a typo from the passphrase — it used to
// say "not wrong", so the typo was sealed into the ticket, the receiving device
// opened without the second question and published the vault's first
// generation under the typo; the sharer was locked out. Now the check says
// "nothing to check against" and Share refuses until something is synced.

import { beforeEach, describe, expect, it } from "vitest";

import { NothingToCheck } from "../../src/passphrase-check.js";
import { resetStub } from "../support/obsidian-stub.js";
import {
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

const TYPO = "plugin harness passphrasf"; // one key off

describe("Q2: Share on a vault with nothing published", () => {
  it("the Share check refuses to answer — for a typo and for the passphrase", async () => {
    const world = new World();
    const a = await makeDevice(world, { ...S3_DATA, deviceId: "dev-a", autoSync: { enabled: false } });
    await unlock(a.plugin, PASS, true); // created; empty local vault -> nothing published
    await settle(a.plugin);
    expect([...mainStore(world).keys()].some((k) => k.includes("manifest"))).toBe(false);
    await expect(a.plugin.passphraseIsWrong(TYPO)).rejects.toBeInstanceOf(NothingToCheck);
    await expect(a.plugin.passphraseIsWrong(PASS)).rejects.toBeInstanceOf(NothingToCheck);
  });

  it("once something is published the check answers both ways", async () => {
    const world = new World();
    const a = await makeDevice(world, { ...S3_DATA, deviceId: "dev-a", autoSync: { enabled: false } });
    await unlock(a.plugin, PASS, true);
    await settle(a.plugin);
    a.adapter.setFile("desk.md", "from the desk");
    await a.plugin.syncNow("manual");
    expect(await a.plugin.passphraseIsWrong(TYPO)).toBe(true);
    expect(await a.plugin.passphraseIsWrong(PASS)).toBe(false);
  });
});
