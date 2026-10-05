// Retry with exponential backoff + full jitter.
//
// Byte-for-byte the same as provider-s3's. The reason this file used to give —
// "kept per-provider so providers stay dependency-independent" — is not true:
// both copies import `isSyncError` from @syncrypt/core, which is where a
// shared one would live. It stays duplicated for now because moving it is a
// four-package change with no behaviour in it, and that is recorded as the
// next consolidation rather than pretended away (ADR-0061).
//
// NOTE: the S3 copy carries a warning this one does not need — that
// `POST ?uploads` is not idempotent (ADR-0060). WebDAV issues no such
// request; every verb this provider retries is idempotent.

import { isSyncError } from "@syncrypt/core";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function isRetryable(e: unknown): boolean {
  return isSyncError(e, "StorageTransient") || isSyncError(e, "StorageRateLimited");
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e) || attempt >= opts.maxRetries) throw e;
      const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
      await sleep(random() * ceiling);
      attempt++;
    }
  }
}
