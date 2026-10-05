// Share connection seals the ticket with the passphrase it verified (audit №4,
// B7; fixed with ADR-0063, held here per ADR-0076). The check runs Argon2id
// for seconds with the field live; reading the field again afterwards sealed
// the ticket with a stray keystroke — the unopenable ticket ADR-0048 §3's
// check exists to prevent.

import { beforeEach, describe, expect, it } from "vitest";

import { openConnectionTicket } from "@syncrypt/crypto";

import { EN_STRINGS } from "../src/i18n.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { ShareConnectionModal } from "../src/ticket-modals.js";
import { resetStub, Setting, type FakeEl } from "./support/obsidian-stub.js";

beforeEach(() => {
  resetStub();
});

describe("share connection", () => {
  it("seals the ticket with the passphrase that was verified", async () => {
    let release: (wrong: boolean) => void = () => undefined;
    const checked: string[] = [];
    const plugin = {
      t: () => EN_STRINGS,
      settings: {
        ...DEFAULT_SETTINGS,
        s3: {
          ...DEFAULT_SETTINGS.s3,
          endpoint: "https://s3.example.com",
          bucket: "b",
          region: "auto",
          accessKeyId: "AK",
          secretAccessKey: "SK",
        },
      },
      passphraseIsWrong: (p: string) => {
        checked.push(p);
        return new Promise<boolean>((r) => {
          release = r;
        });
      },
    };
    const modal = new ShareConnectionModal({} as never, plugin as never);
    modal.open();
    const row = Setting.rows.find((r) => r.name === EN_STRINGS.shareModal.passphrase);
    const field = row?.texts[0];
    if (field === undefined) throw new Error("no passphrase field");
    await field.type("vault passphrase");
    const content = (modal as unknown as { contentEl: FakeEl }).contentEl;
    content.button(EN_STRINGS.shareModal.generate).click();
    await field.type("vault passphrasee"); // a stray key during the check
    release(false); // the check said the FIRST string is right
    let area: FakeEl | undefined;
    for (let i = 0; i < 300 && area === undefined; i++) {
      await new Promise((r) => setTimeout(r, 10));
      area = content.all().find((e) => e.tag === "textarea");
    }
    if (area === undefined) throw new Error("no ticket");
    expect(checked).toEqual(["vault passphrase"]);
    await expect(openConnectionTicket(area.value, "vault passphrase")).resolves.toBeDefined();
  });
});
