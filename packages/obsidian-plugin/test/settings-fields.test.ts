// ADR-0074: a settings field stores what it means and shows what it stored.
// Audit №4: a prefix with a leading slash was refused locally and reported as
// an unreachable storage (A10); the plaintext and stored-keys warnings were
// computed once per draw and missed S3 keys left behind by a switch to WebDAV
// (A11); number fields stored "" as 0, "0.5" days as "for ever", and kept a
// refused value on screen (A12). And a WebDAV password lost its edge spaces.

import { beforeEach, describe, expect, it } from "vitest";

import { EN_STRINGS, stringsFor } from "../src/i18n.js";
import { normalizePrefix, withDefaults } from "../src/settings.js";
import {
  prefixHasEmptySegment,
  unlockFailureMessage,
  UnusablePrefix,
} from "../src/unlock-error.js";
import { resetStub, type FakeEl } from "./support/obsidian-stub.js";
import {
  field,
  mainStore,
  makeDevice,
  PASS,
  renderTab,
  S3_DATA,
  saved,
  unlock,
  World,
} from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const T = EN_STRINGS.settings;

describe("prefix (A10)", () => {
  it.each([
    ["/notes/", "notes"],
    ["notes//2026/", "notes/2026"],
    ["  vaults/main  ", "vaults/main"],
    ["///", ""],
    ["vaults/main", "vaults/main"],
  ])("%j → %j", (typed, stored) => {
    expect(normalizePrefix(typed)).toBe(stored);
  });

  it("typed into Settings, it is stored normalized and shown so on leaving", async () => {
    const me = await makeDevice(new World(), S3_DATA);
    renderTab(me);
    const f = field(T.prefix);
    await f.type("/vaults//main/");
    expect(saved(me).s3.prefix).toBe("vaults/main");
    f.inputEl.dispatch("blur");
    expect(f.getValue()).toBe("vaults/main");
  });

  // ADR-0081: an S3 prefix is kept as stored — beta.12 used it as typed and S3
  // keeps such keys, so normalizing it on load moved the vault (R4).
  it("an S3 prefix with an empty part is kept; the unlock says why it is refused", async () => {
    const world = new World();
    const legacy = { ...S3_DATA, s3: { ...S3_DATA.s3, prefix: "/vaults/main" } };
    const me = await makeDevice(world, legacy);
    expect(me.plugin.settings.s3.prefix).toBe("/vaults/main");
    await expect(unlock(me.plugin, PASS, true)).rejects.toBeInstanceOf(UnusablePrefix);
    expect(unlockFailureMessage(new UnusablePrefix("/vaults/main"), EN_STRINGS)).toBe(
      EN_STRINGS.unlockModal.prefixUnusable("/vaults/main"),
    );
    expect(mainStore(world).keys()).toEqual([]); // nothing created anywhere
  });

  it("withDefaults keeps an S3 prefix and normalizes a WebDAV one", () => {
    const s = withDefaults(
      { s3: { prefix: "/a/" }, webdav: { prefix: "b//c" } },
      { mobile: false },
    );
    expect([s.s3.prefix, s.webdav.prefix]).toEqual(["/a/", "b/c"]);
  });

  it.each([
    ["/notes", true],
    ["a//b", true],
    ["notes/", false],
    ["notes", false],
    ["", false],
  ])("prefixHasEmptySegment(%j) is %s", (prefix, empty) => {
    expect(prefixHasEmptySegment(prefix)).toBe(empty);
  });
});

describe("WebDAV password", () => {
  it("is stored as typed, spaces and all", async () => {
    const me = await makeDevice(new World(), { ...S3_DATA, provider: "webdav" });
    renderTab(me);
    await field(T.webdavPassword).type(" pass word ");
    expect(saved(me).webdav.password).toBe(" pass word ");
  });
});

describe("warnings follow the fields (A11)", () => {
  const visible = (me: { plugin: object }, text: string): boolean => {
    const tab = (me.plugin as unknown as { settingTab: { containerEl: FakeEl } }).settingTab;
    return tab.containerEl.textDeep().includes(text);
  };

  it("typing an http:// endpoint shows the plaintext warning, https hides it", async () => {
    const me = await makeDevice(new World(), S3_DATA);
    renderTab(me);
    expect(visible(me, T.plaintextEndpointWarning)).toBe(false);
    await field(T.endpoint).type("http://nas.example.com:9000");
    expect(visible(me, T.plaintextEndpointWarning)).toBe(true);
    await field(T.endpoint).type("https://nas.example.com:9000");
    expect(visible(me, T.plaintextEndpointWarning)).toBe(false);
  });

  it("S3 keys still stored while WebDAV is active are warned about", async () => {
    const me = await makeDevice(new World(), { ...S3_DATA, provider: "webdav" });
    renderTab(me);
    expect(visible(me, T.credentialWarning)).toBe(true);
  });

  it("no keys anywhere: no warning; the first key typed: the warning", async () => {
    const me = await makeDevice(new World(), {
      ...S3_DATA,
      s3: { ...S3_DATA.s3, accessKeyId: "", secretAccessKey: "" },
    });
    renderTab(me);
    expect(visible(me, T.credentialWarning)).toBe(false);
    await field(T.accessKeyId).type("AKIA");
    expect(visible(me, T.credentialWarning)).toBe(true);
  });
});

describe("number fields (A12)", () => {
  async function tab() {
    const me = await makeDevice(new World(), S3_DATA);
    renderTab(me);
    return me;
  }
  const invalid = (name: string): boolean =>
    field(name).inputEl.attrs["aria-invalid"] === "true";

  it("clearing a field to retype it stores nothing", async () => {
    const me = await tab();
    const before = saved(me).safeSync.deletionBurstWindow;
    await field(T.deletionBurstWindow).type("");
    expect(saved(me).safeSync.deletionBurstWindow).toBe(before);
    expect(invalid(T.deletionBurstWindow)).toBe(true);
  });

  it("half a day is refused, not stored as 'for ever'", async () => {
    const me = await tab();
    const before = saved(me).safeSync.tombstoneGraceSeconds;
    await field(T.tombstoneGrace).type("0.5");
    expect(saved(me).safeSync.tombstoneGraceSeconds).toBe(before);
    expect(invalid(T.tombstoneGrace)).toBe(true);
  });

  it("a negative number is refused where no floor would catch it", async () => {
    const me = await tab();
    const before = saved(me).safeSync.deletionBurstWindow;
    await field(T.deletionBurstWindow).type("-5");
    expect(saved(me).safeSync.deletionBurstWindow).toBe(before);
    expect(invalid(T.deletionBurstWindow)).toBe(true);
  });

  it("a refused value does not stay on screen", async () => {
    const me = await tab();
    const f = field(T.versionsToKeep);
    await f.type("-1");
    f.inputEl.dispatch("blur");
    expect(f.getValue()).toBe(String(saved(me).safeSync.versionsToKeep));
    expect(invalid(T.versionsToKeep)).toBe(false);
  });

  it("a floored value shows its floor on leaving", async () => {
    const me = await tab();
    const f = field(T.versionsToKeep);
    await f.type("0");
    f.inputEl.dispatch("blur");
    expect(f.getValue()).toBe(String(saved(me).safeSync.versionsToKeep));
    expect(saved(me).safeSync.versionsToKeep).toBeGreaterThan(0);
  });

  it("the fraction field takes a fraction", async () => {
    const me = await tab();
    await field(T.vaultFraction).type("0.25");
    expect(saved(me).safeSync.bulkChangeMaxFraction).toBe(0.25);
    expect(invalid(T.vaultFraction)).toBe(false);
  });

  it("a whole number is stored", async () => {
    const me = await tab();
    await field(T.deletionBurstWindow).type(" 120 ");
    expect(saved(me).safeSync.deletionBurstWindow).toBe(120);
  });
});

describe("texts that named the wrong thing (B15)", () => {
  const langs = [EN_STRINGS, stringsFor("ru")];

  it("forgetting's safety note names the release command by its full name", () => {
    for (const s of langs) expect(s.forgetModal.safety).toContain(s.commands.releaseForgotten);
  });

  it("the reclaim and release buttons are not the same word", () => {
    for (const s of langs) expect(s.reclaimModal.confirm).not.toBe(s.releaseModal.confirm);
  });

  it("accepting a storage does not promise that nothing is transferred", () => {
    expect(EN_STRINGS.acceptStorageModal.effect).not.toMatch(/nothing is uploaded/i);
    expect(stringsFor("ru").acceptStorageModal.effect).not.toMatch(/ничего не загружается/i);
  });
});
