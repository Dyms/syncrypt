// Retry with exponential backoff + full jitter (RFC-0006 §S3 implementation
// notes). Only Transient and RateLimited are retried — everything else is a
// definitive answer.
//
// NOT "all S3 operations we issue are idempotent", which is what this comment
// used to claim and what a reader would reasonably rely on. PUT, GET, HEAD,
// DELETE and LIST are; `POST ?uploads` is not — retrying it after a request
// the server carried out but failed to answer creates a SECOND multipart
// upload and orphans the first, whose parts are billed and appear in no
// object listing. That one request owns its own cleanup, in
// `S3Storage.multipartPut` (ADR-0060). Anything added here later must say
// which it is.

import { isSyncError } from "@syncrypt/core";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injectable for deterministic tests. */
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
      // Full jitter: uniform in [0, min(maxDelay, base * 2^attempt)].
      const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
      await sleep(random() * ceiling);
      attempt++;
    }
  }
}
