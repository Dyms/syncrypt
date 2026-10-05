// ADR-0078: a vault with nothing published cannot check a passphrase, so the
// unlock asks for it twice. Audit №4 found it while checking B11's fix: an
// empty vault's verifyAccess returns null, and a typo unlocked — the first
// push would then encrypt the vault's first manifest under a key no other
// device has.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EN_STRINGS } from "../src/i18n.js";
import { PassphraseModal } from "../src/unlock.js";
import { UncheckablePassphrase, UnlockFlow } from "../src/unlock-flow.js";
import { resetStub, type FakeEl } from "./support/obsidian-stub.js";
import { makeDevice, PASS, S3_DATA, settle, unlock, World } from "./support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const T = EN_STRINGS.unlockModal;

describe("UnlockFlow", () => {
  function flow() {
    const calls: [string, boolean, boolean][] = [];
    const f = new UnlockFlow(
      (p, create, confirmed) => {
        calls.push([p, create, confirmed]);
        return confirmed ? Promise.resolve() : Promise.reject(new UncheckablePassphrase());
      },
      EN_STRINGS,
      "s3 · notes",
    );
    return { f, calls };
  }

  it("asks again, then opens with the passphrase confirmed", async () => {
    const { f, calls } = flow();
    expect(await f.submit("pass")).toEqual({
      kind: "confirm-unchecked",
      message: T.uncheckable("s3 · notes"),
    });
    expect(f.creating).toBe(false); // the button still says Unlock
    expect(await f.submit("pass")).toEqual({ kind: "done" });
    expect(calls).toEqual([
      ["pass", false, false],
      ["pass", false, true],
    ]);
  });

  it("two different passphrases open nothing", async () => {
    const { f, calls } = flow();
    await f.submit("pass");
    expect(await f.submit("pasS")).toEqual({ kind: "error", message: T.confirmMismatch });
    expect(calls).toHaveLength(1);
    expect((await f.submit("pass")).kind).toBe("confirm-unchecked"); // starts over
  });
});

describe("the dialog shows the question", () => {
  it("as it does for creating", async () => {
    let first = true;
    const modal = new PassphraseModal(
      {} as never,
      () => {
        const again = first;
        first = false;
        return again ? Promise.reject(new UncheckablePassphrase()) : Promise.resolve();
      },
      undefined,
      EN_STRINGS,
      "s3 · notes",
    );
    modal.open();
    (modal as unknown as { passphrase: string }).passphrase = "pass";
    await (modal as unknown as { submit(): Promise<void> }).submit();
    const parts = modal as unknown as { questionEl: FakeEl; errorEl: FakeEl };
    // A question, in the question's place — not an error.
    expect(parts.questionEl.hidden).toBe(false);
    expect(parts.questionEl.text).toBe(T.uncheckable("s3 · notes"));
    expect(parts.errorEl.hidden).toBe(true);
  });
});

describe("in the plugin", () => {
  async function emptyVault() {
    const world = new World();
    const seed = await makeDevice(world, { ...S3_DATA, deviceId: "dev-seed" });
    await unlock(seed.plugin, PASS, true); // created, nothing to publish
    await settle(seed.plugin);
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    return me;
  }

  it("an unlock against an empty vault is a question, not an open vault", async () => {
    const me = await emptyVault();
    await expect(unlock(me.plugin, "pass with a typo")).rejects.toBeInstanceOf(
      UncheckablePassphrase,
    );
    expect(me.plugin.isUnlocked()).toBe(false);
    // ...and not a failure in the log
    expect(me.plugin.log.all().filter((l) => l.level === "warn")).toEqual([]);
  });

  it("confirmed, it opens", async () => {
    const me = await emptyVault();
    await (me.plugin as unknown as {
      unlock(p: string, c: boolean, k: boolean): Promise<void>;
    }).unlock(PASS, false, true);
    expect(me.plugin.isUnlocked()).toBe(true);
  });

  it("a ticket's passphrase counts as confirmed", async () => {
    const me = await emptyVault();
    await me.plugin.connectWithPassphrase(PASS);
    expect(me.plugin.isUnlocked()).toBe(true);
  });

  it("the dialog passes the confirmation through", async () => {
    const me = await emptyVault();
    const spy = vi.spyOn(me.plugin as unknown as { unlock(...a: unknown[]): Promise<void> }, "unlock");
    me.plugin.promptUnlock();
    const modal = (me.plugin as unknown as { unlockModal: PassphraseModal }).unlockModal;
    const submit = (p: string): Promise<void> => {
      (modal as unknown as { passphrase: string }).passphrase = p;
      return (modal as unknown as { submit(): Promise<void> }).submit();
    };
    await submit(PASS);
    await submit(PASS);
    expect(spy.mock.calls.map((c) => c.slice(1))).toEqual([
      [false, false],
      [false, true],
    ]);
    expect(me.plugin.isUnlocked()).toBe(true);
  });
});
