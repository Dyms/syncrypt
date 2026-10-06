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
/**
 * The configured prefix has an empty segment — "/notes", "a//b" — which the
 * object-key check refuses before any request (ADR-0058). beta.12 sent such
 * keys to S3 and S3 stored them, so a vault may live there; this version will
 * not silently move it, and says so instead of "could not reach the storage"
 * (ADR-0081).
 */
export class UnusablePrefix extends Error {
  constructor(readonly prefix: string) {
    super(`prefix "${prefix}" has an empty segment`);
    this.name = "UnusablePrefix";
  }
}

/** "/notes", "a//b": a segment that is empty once trailing slashes go. */
export function prefixHasEmptySegment(prefix: string): boolean {
  const p = prefix.trim().replace(/\/+$/, "");
  return p !== "" && p.split("/").some((segment) => segment === "");
}

/**
 * The storage settings were edited while this unlock derived its keys: the
 * engine it built points at the location the settings no longer name
 * (ADR-0081, post-fix Q6).
 */
export class LocationChanged extends Error {
  constructor() {
    super("the storage settings changed during the unlock");
    this.name = "LocationChanged";
  }
}

/**
 * What the last session left running has not stopped yet — a request that
 * hangs is only seen as aborted when it returns (ADR-0081, post-fix Q4).
 * Opening beside it would be two engines on one vault.
 */
export class PreviousSessionBusy extends Error {
  constructor() {
    super("the previous session's sync has not stopped yet");
    this.name = "PreviousSessionBusy";
  }
}

/** data.json belongs to a newer build; nothing here may write it (ADR-0075, Q9). */
export class SettingsReadOnly extends Error {
  constructor(readonly provider: string) {
    super(`settings are read-only: provider "${provider}" is from a newer build`);
    this.name = "SettingsReadOnly";
  }
}

export function unlockFailureMessage(error: unknown, t: Strings): string {
  if (error instanceof UnusablePrefix) return t.unlockModal.prefixUnusable(error.prefix);
  if (error instanceof LocationChanged) return t.unlockModal.locationChanged;
  if (error instanceof PreviousSessionBusy) return t.unlockModal.previousBusy;
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
  if (error instanceof SettingsReadOnly) return t.notices.newerData(error.provider);
  if (isSyncError(error, "CryptoAuthError")) return t.notices.ticketDidNotOpen;
  return t.notices.commandFailedDetail(String(error));
}
