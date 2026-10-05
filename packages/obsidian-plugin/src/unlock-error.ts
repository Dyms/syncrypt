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
  // Checked before anything else could claim it: the passphrase was never
  // tried, so "wrong passphrase" here sends a person who typed it correctly
  // back to retype it, forever (ADR-0063).
  if (isSyncError(error, "KdfUnaffordable")) return t.unlockModal.kdfUnaffordable;
  // The dialog turns this into a question (unlock-flow.ts); everywhere else —
  // a ticket, a notice — it is the answer (ADR-0065).
  if (isSyncError(error, "VaultAbsent")) return t.unlockModal.vaultAbsentElsewhere;
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

/**
 * A maintenance command (forget, release, reclaim, accept) failed while the
 * vault was open. The same codes as above, read for a different moment: the
 * keys are known good here, so an authentication or manifest failure is the
 * storage refusing — and the engine has already logged why (ADR-0041's
 * rollback refusal, for one). These commands used to drop every failure on
 * the floor (audit №4, B9).
 */
export function commandFailureMessage(error: unknown, t: Strings): string {
  if (
    isSyncError(error, "StorageTransient") ||
    isSyncError(error, "StorageRateLimited") ||
    isSyncError(error, "StorageNotFound")
  ) {
    return t.unlockModal.storageUnreachable;
  }
  if (isSyncError(error, "StorageUnauthorized")) return t.unlockModal.storageUnauthorized;
  if (isSyncError(error, "ManifestCorrupt") || isSyncError(error, "CryptoAuthError")) {
    return t.notices.commandRefused;
  }
  return t.notices.commandFailedDetail(String(error));
}

/**
 * A sync failed after a good unlock (ADR-0073). The notice used to carry the
 * raw error — "SyncError: S3 probe-create …: network error" in an otherwise
 * Russian interface (audit №4, B13). The raw text still goes to the log.
 */
export function syncFailureMessage(error: unknown, t: Strings): string {
  if (
    isSyncError(error, "StorageTransient") ||
    isSyncError(error, "StorageRateLimited") ||
    isSyncError(error, "StorageNotFound")
  ) {
    return t.unlockModal.storageUnreachable;
  }
  if (isSyncError(error, "StorageUnauthorized")) return t.unlockModal.storageUnauthorized;
  if (isSyncError(error, "CryptoAuthError")) return t.notices.syncNotAuthentic;
  if (isSyncError(error, "ManifestCorrupt")) return t.notices.syncManifestRefused;
  return t.notices.commandFailedDetail(String(error));
}

/**
 * A pasted ticket that did not open (ADR-0073). Every way a ticket fails to
 * open is CryptoAuthError by design — a wrong passphrase and a cut-off paste
 * look the same to GCM — so the message names both.
 */
export function ticketFailureMessage(error: unknown, t: Strings): string {
  if (isSyncError(error, "CryptoAuthError")) return t.notices.ticketDidNotOpen;
  return t.notices.commandFailedDetail(String(error));
}
