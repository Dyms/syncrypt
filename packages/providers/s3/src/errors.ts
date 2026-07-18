// Error normalization to the RFC-0007 taxonomy (RFC-0006 §Error contract).
//
// Messages carry the HTTP status, the S3 <Code>, and the object key — and
// NOTHING else. Credentials, signatures, and headers never appear in errors.

import { SyncError, type SyncErrorCode } from "@syncrypt/core";

/** Extract <Code>…</Code> from an S3 error body, if present. */
export function s3ErrorCode(body: string): string | null {
  const m = /<Code>([^<]{1,64})<\/Code>/.exec(body);
  return m?.[1] ?? null;
}

const UNAUTHORIZED_CODES = new Set([
  "AccessDenied",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "ExpiredToken",
  "TokenRefreshRequired",
]);
const RATE_LIMITED_CODES = new Set(["SlowDown", "RequestLimitExceeded", "Throttling"]);
const NOT_FOUND_CODES = new Set(["NoSuchKey", "NoSuchBucket", "NotFound"]);

/** Map an HTTP response (status + parsed S3 code) to the typed taxonomy. */
export function normalizeS3Error(
  status: number,
  code: string | null,
  key: string,
  operation: string,
): SyncError {
  const detail = `S3 ${operation} "${key}": HTTP ${status}${code !== null ? ` ${code}` : ""}`;
  const mapped: SyncErrorCode =
    code !== null && NOT_FOUND_CODES.has(code)
      ? "StorageNotFound"
      : status === 404
        ? "StorageNotFound"
        : status === 412 || code === "PreconditionFailed"
          ? "StoragePreconditionFailed"
          : status === 401 || status === 403 || (code !== null && UNAUTHORIZED_CODES.has(code))
            ? "StorageUnauthorized"
            : status === 429 || (code !== null && RATE_LIMITED_CODES.has(code))
              ? "StorageRateLimited"
              : "StorageTransient"; // other 4xx/5xx: retryable-or-surfaced upstream
  return new SyncError(mapped, detail);
}

/** Network-level failures (fetch TypeError, aborted sockets) are Transient. */
export function normalizeNetworkError(e: unknown, key: string, operation: string): SyncError {
  if (e instanceof SyncError) return e;
  // String(e) on fetch errors carries no request data (and never credentials).
  return new SyncError("StorageTransient", `S3 ${operation} "${key}": network error (${String(e)})`, e);
}
