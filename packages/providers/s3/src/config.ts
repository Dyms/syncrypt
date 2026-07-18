// S3 provider configuration (RFC-0006 §S3 implementation notes).
// Credentials are SECRETS: they live only here and in signed request headers —
// never in logs, error messages, or the manifest.

import type { HttpTransport } from "./transport.js";

export interface S3RetryConfig {
  /** Retries after the first attempt (default 4). */
  maxRetries?: number;
  /** Base for exponential backoff (default 200 ms). */
  baseDelayMs?: number;
  /** Backoff ceiling (default 5000 ms). */
  maxDelayMs?: number;
}

export interface S3Config {
  /** Endpoint origin, e.g. "https://s3.eu-central-1.amazonaws.com" or "http://127.0.0.1:9000". */
  endpoint: string;
  bucket: string;
  region?: string; // default "us-east-1" (MinIO and friends accept anything)
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /**
   * Path-style ("endpoint/bucket/key", default true — every S3-compatible
   * backend supports it) vs virtual-hosted ("bucket.endpoint/key").
   */
  forcePathStyle?: boolean;
  /**
   * Conditional-write capability: "probe" (default) verifies the backend's
   * actual behavior once at create(); true/false skips the probe and asserts.
   */
  conditionalWrites?: boolean | "probe";
  /** Objects larger than this are uploaded via multipart (default 64 MiB). */
  multipartThresholdBytes?: number;
  /** Multipart part size (default 16 MiB; S3 minimum is 5 MiB per part). */
  partSizeBytes?: number;
  retry?: S3RetryConfig;
  /**
   * HTTP transport for the SIGNED requests (RFC-0006 §Injectable transport).
   * Default: global fetch. Obsidian clients must inject a requestUrl()-backed
   * transport — webview fetch is blocked by CORS on S3/MinIO.
   */
  transport?: HttpTransport;
}

export const S3_DEFAULTS = {
  region: "us-east-1",
  forcePathStyle: true,
  multipartThresholdBytes: 64 * 1024 * 1024,
  partSizeBytes: 16 * 1024 * 1024,
  maxRetries: 4,
  baseDelayMs: 200,
  maxDelayMs: 5000,
} as const;

export const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
