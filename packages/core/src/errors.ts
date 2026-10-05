// Typed error taxonomy — RFC-0007 §6.
//
// CryptoAuthError, VaultKeyfileMissing, KdfUnaffordable and ManifestCorrupt are
// FAIL-CLOSED: the affected data is never applied, and in the keyfile's case
// nothing is created over it. StoragePreconditionFailed maps to "pull first".
// StorageTransient / StorageRateLimited are retryable with backoff.

export type SyncErrorCode =
  | "StorageNotFound"
  | "StoragePreconditionFailed"
  | "StorageUnauthorized"
  | "StorageTransient"
  | "StorageRateLimited"
  | "VaultFileNotFound"
  | "VaultWriteFailed"
  | "CryptoAuthError" // GCM tag mismatch / wrong passphrase (fail-closed)
  | "VaultKeyfileMissing" // storage holds data but not the salt that opens it
  // The vault's KDF needs more memory than this device's budget (ADR-0018).
  // Says NOTHING about the passphrase, which was never tried (ADR-0063).
  | "KdfUnaffordable"
  // Nothing at this location, and the caller did not ask to create a vault
  // there (ADR-0065). A typed prefix one letter off lands here, not in a new,
  // empty vault beside the real one.
  | "VaultAbsent"
  | "ManifestCorrupt"
  | "ManifestForkUnresolved"
  | "Aborted"; // AbortSignal fired

export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export function isSyncError(e: unknown, code?: SyncErrorCode): e is SyncError {
  return e instanceof SyncError && (code === undefined || e.code === code);
}
