// Retry with exponential backoff + full jitter — mirrors provider-s3's
// (kept per-provider so providers stay dependency-independent).

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
