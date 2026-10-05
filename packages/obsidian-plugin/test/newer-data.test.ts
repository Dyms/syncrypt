// ADR-0075: a data.json written by a newer Syncrypt survives an older one.
// Audit №4 (A8): withDefaults dropped unknown top-level fields and turned an
// unknown provider into "s3", and the first launch wrote that back — the newer
// build's settings were gone for good, and the downgrade connected to the S3
// group still in the file, i.e. the old storage.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EN_STRINGS } from "../src/i18n.js";
import { foreignProvider, unknownKeys } from "../src/settings.js";
import { PassphraseModal } from "../src/unlock.js";
import { Modal, Notice, Plugin, resetStub } from "./support/obsidian-stub.js";
import { field, makeDevice, PASS, renderTab, S3_DATA, unlock, World } from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const NEWER = {
  ...S3_DATA,
  provider: "sftp",
  sftp: { host: "nas.local", user: "me" },
  someFutureFlag: true,
};

const written = (d: { plugin: object }): Record<string, unknown> =>
  (d.plugin as unknown as { data: Record<string, unknown> }).data;

describe("pure helpers", () => {
  it("foreignProvider", () => {
    expect(foreignProvider({ provider: "sftp" })).toBe("sftp");
    expect(foreignProvider({ provider: "s3" })).toBeNull();
    expect(foreignProvider({ provider: "webdav" })).toBeNull();
    expect(foreignProvider({})).toBeNull();
    expect(foreignProvider(null)).toBeNull();
    expect(foreignProvider({ provider: 3 })).toBe("3");
  });
  it("unknownKeys", () => {
    expect(unknownKeys({ s3: {}, deviceId: "x", sftp: 1, flag: true })).toEqual({ sftp: 1, flag: true });
    expect(unknownKeys("nope")).toEqual({});
  });
});

describe("an older build under a newer data.json", () => {
  it("does not rewrite it", async () => {
    const d = await makeDevice(new World(), structuredClone(NEWER));
    expect(written(d)).toEqual(NEWER);
  });

  it("says why, once, and does not connect", async () => {
    const d = await makeDevice(new World(), structuredClone(NEWER));
    expect(Notice.shown).toEqual([EN_STRINGS.notices.newerData("sftp")]);
    d.plugin.promptUnlock();
    expect(Modal.opened.filter((m) => m instanceof PassphraseModal)).toEqual([]);
    expect(Notice.shown).toHaveLength(2); // the prompt says it again, instead of a dialog
    await unlock(d.plugin, PASS, true);
    expect(d.plugin.isUnlocked()).toBe(false);
  });

  it("an edit in Settings is not saved over it", async () => {
    const d = await makeDevice(new World(), structuredClone(NEWER));
    renderTab(d);
    await field(EN_STRINGS.settings.bucket).type("other");
    expect(written(d)).toEqual(NEWER);
  });

  it("a known provider with unknown fields: the fields ride along on every write", async () => {
    const data = { ...S3_DATA, someFutureFlag: true, futureGroup: { a: 1 } };
    const d = await makeDevice(new World(), structuredClone(data));
    renderTab(d);
    await field(EN_STRINGS.settings.bucket).type("other");
    expect(written(d).someFutureFlag).toBe(true);
    expect(written(d).futureGroup).toEqual({ a: 1 });
    expect((written(d).s3 as { bucket: string }).bucket).toBe("other");
  });

  it("a file that needs nothing new is not rewritten on launch", async () => {
    const world = new World();
    const first = await makeDevice(world, structuredClone({ ...S3_DATA, someFutureFlag: true }));
    const settled = structuredClone(written(first));
    const save = vi.spyOn(Plugin.prototype, "saveData");
    const again = await makeDevice(world, structuredClone(settled));
    expect(save).not.toHaveBeenCalled();
    expect(written(again)).toEqual(settled);
    save.mockRestore();
  });
});
