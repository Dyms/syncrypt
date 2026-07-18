// @syncrypt/provider-s3 — S3-compatible StorageProvider (RFC-0006, ADR-0015).

export * from "./config.js";
export * from "./storage.js";
export * from "./transport.js";
export { S3Client, S3Response } from "./client.js";
export { normalizeS3Error, s3ErrorCode } from "./errors.js";
export { withRetry, isRetryable, type RetryOptions } from "./retry.js";
