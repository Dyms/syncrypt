// Turning an unlock failure into something a human can act on. Pure (no
// `obsidian` import) so the wording is unit-tested rather than eyeballed.

import { isSyncError } from "@syncrypt/core";

import type { Strings } from "./i18n.js";

/**
 * A wrong passphrase and tampered data are indistinguishable by design — GCM
 * only tells us "this did not authenticate" — so the message names the likely
 * cause first and the alarming one second. Storage failures are NOT dressed up
 * as a wrong passphrase: an unreachable bucket says so.
 */
export function unlockFailureMessage(error: unknown, t: Strings): string {
  if (isSyncError(error, "CryptoAuthError")) return t.unlockModal.wrongPassphrase;
  if (isSyncError(error, "ManifestCorrupt")) return t.unlockModal.manifestCorrupt;
  // Not "wrong passphrase" and not "storage unreachable": the storage answered,
  // and what it said is that the salt is gone. The fix is a restore, and this
  // is the one screen where saying so early costs nothing.
  if (isSyncError(error, "VaultKeyfileMissing")) return t.unlockModal.keyfileMissing;
  if (isSyncError(error, "StorageUnauthorized")) return t.unlockModal.storageUnauthorized;
  if (
    isSyncError(error, "StorageTransient") ||
    isSyncError(error, "StorageRateLimited") ||
    isSyncError(error, "StorageNotFound")
  ) {
    return t.unlockModal.storageUnreachable;
  }
  return t.unlockModal.otherFailure(String(error));
}
