// A failed unlock must say what actually went wrong: a wrong passphrase and an
// unreachable bucket are different problems with different fixes.

import { describe, expect, it } from "vitest";

import { SyncError } from "@syncrypt/core";

import { EN_STRINGS, stringsFor } from "../src/i18n.js";
import { unlockFailureMessage } from "../src/unlock-error.js";

describe("unlockFailureMessage", () => {
  it("names the passphrase for an authentication failure", () => {
    const message = unlockFailureMessage(
      new SyncError("CryptoAuthError", "decryption failed"),
      EN_STRINGS,
    );
    expect(message).toBe(EN_STRINGS.unlockModal.wrongPassphrase);
    expect(message.toLowerCase()).toContain("passphrase");
  });

  it("does NOT blame the passphrase for storage problems", () => {
    const cases: [string, string][] = [
      ["StorageUnauthorized", EN_STRINGS.unlockModal.storageUnauthorized],
      ["StorageTransient", EN_STRINGS.unlockModal.storageUnreachable],
      ["StorageRateLimited", EN_STRINGS.unlockModal.storageUnreachable],
      ["StorageNotFound", EN_STRINGS.unlockModal.storageUnreachable],
    ];
    for (const [code, expected] of cases) {
      const message = unlockFailureMessage(
        new SyncError(code as "StorageTransient", "boom"),
        EN_STRINGS,
      );
      expect(message, code).toBe(expected);
      expect(message, code).not.toBe(EN_STRINGS.unlockModal.wrongPassphrase);
    }
  });

  it("separates a corrupt manifest from a wrong passphrase", () => {
    expect(
      unlockFailureMessage(new SyncError("ManifestCorrupt", "bad"), EN_STRINGS),
    ).toBe(EN_STRINGS.unlockModal.manifestCorrupt);
  });

  it("falls back to the raw detail for anything unexpected", () => {
    expect(unlockFailureMessage(new Error("kaboom"), EN_STRINGS)).toContain("kaboom");
  });

  it("speaks the reader's language", () => {
    const ru = stringsFor("ru");
    expect(
      unlockFailureMessage(new SyncError("CryptoAuthError", "x"), ru),
    ).toBe(ru.unlockModal.wrongPassphrase);
    expect(ru.unlockModal.wrongPassphrase).toContain("Caps Lock");
  });
});
