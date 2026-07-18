// Typed error taxonomy — RFC-0007 §6.
//
// CryptoAuthError and ManifestCorrupt are FAIL-CLOSED: the affected data is
// never applied. StoragePreconditionFailed maps to "pull first".
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
