// Live S3-compatible test backend resolution. Set SYNCRYPT_S3_TEST_ENDPOINT
// (e.g. http://127.0.0.1:9000, a local MinIO) to enable the live suites;
// without it they skip with a visible warning. CI always provides MinIO.

import type { S3Config } from "../src/config.js";

export interface LiveS3 {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function liveS3FromEnv(): LiveS3 | null {
  const endpoint = process.env.SYNCRYPT_S3_TEST_ENDPOINT;
  if (endpoint === undefined || endpoint === "") return null;
  return {
    endpoint,
    accessKeyId: process.env.SYNCRYPT_S3_TEST_ACCESS_KEY ?? "minioadmin",
    secretAccessKey: process.env.SYNCRYPT_S3_TEST_SECRET_KEY ?? "minioadmin",
  };
}

export function randomBucketName(): string {
  const raw = crypto.getRandomValues(new Uint8Array(6));
  return `syncrypt-test-${[...raw].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function bucketConfig(live: LiveS3, overrides: Partial<S3Config> = {}): S3Config {
  return {
    endpoint: live.endpoint,
    bucket: randomBucketName(),
    accessKeyId: live.accessKeyId,
    secretAccessKey: live.secretAccessKey,
    forcePathStyle: true,
    retry: { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 500 },
    ...overrides,
  };
}

export function warnSkipped(what: string): void {
  console.warn(
    `⚠ ${what} SKIPPED — no live S3 backend. Set SYNCRYPT_S3_TEST_ENDPOINT (local MinIO) to run it.`,
  );
}
