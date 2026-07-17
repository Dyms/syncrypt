// S3Storage — StoragePort over any S3-compatible backend (RFC-0006).
//
// The engine's manifest concurrency is LIST-based and provider-agnostic
// (ADR-0006 + erratum); this provider only implements the universal subset
// honestly. Conditional writes are probed once at create() and honored on
// single PUTs when supported; multipart handles large objects; Transient and
// RateLimited failures retry with backoff + jitter.

import {
  SyncError,
  type ObjectKey,
  type ObjectStat,
  type ProviderCapabilities,
  type PutOptions,
  type PutResult,
  type StoragePort,
} from "@syncrypt/core";

import { S3Client } from "./client.js";
import { MIN_PART_SIZE_BYTES, S3_DEFAULTS, type S3Config } from "./config.js";
import { normalizeS3Error, s3ErrorCode } from "./errors.js";
import { withRetry, type RetryOptions } from "./retry.js";
import {
  buildCompleteMultipartUpload,
  embeddedErrorCode,
  parseInitiateMultipartUpload,
  parseListObjectsV2,
} from "./xml.js";

export class S3Storage implements StoragePort {
  private constructor(
    private readonly client: S3Client,
    private readonly conditional: boolean,
    private readonly multipartThreshold: number,
    private readonly partSize: number,
    private readonly retryOpts: RetryOptions,
  ) {}

  /**
   * Build the provider. With conditionalWrites: "probe" (default) this issues
   * a handful of requests against a throwaway key to verify the backend's
   * ACTUAL conditional-write behavior — capabilities() must be honest
   * (RFC-0006 §S3 implementation notes).
   */
  static async create(config: S3Config): Promise<S3Storage> {
    const retryOpts: RetryOptions = {
      maxRetries: config.retry?.maxRetries ?? S3_DEFAULTS.maxRetries,
      baseDelayMs: config.retry?.baseDelayMs ?? S3_DEFAULTS.baseDelayMs,
      maxDelayMs: config.retry?.maxDelayMs ?? S3_DEFAULTS.maxDelayMs,
    };
    const client = new S3Client(config);
    const mode = config.conditionalWrites ?? "probe";
    const conditional =
      mode === "probe" ? await probeConditionalWrites(client, retryOpts) : mode;
    const partSize = Math.max(
      config.partSizeBytes ?? S3_DEFAULTS.partSizeBytes,
      MIN_PART_SIZE_BYTES,
    );
    return new S3Storage(
      client,
      conditional,
      config.multipartThresholdBytes ?? S3_DEFAULTS.multipartThresholdBytes,
      partSize,
      retryOpts,
    );
  }

  async put(key: ObjectKey, data: Uint8Array, opts?: PutOptions): Promise<PutResult> {
    // Conditional options are consulted only when the capability is present
    // (RFC-0006). Conditional payloads (manifests, keyfile) are small, so the
    // multipart path never needs conditions.
    const conditionalHeaders: Record<string, string> = {};
    if (this.conditional && opts) {
      if (opts.ifMatch !== undefined) conditionalHeaders["if-match"] = opts.ifMatch;
      if (opts.ifNoneMatch !== undefined) conditionalHeaders["if-none-match"] = opts.ifNoneMatch;
    }
    const hasConditions = Object.keys(conditionalHeaders).length > 0;
    if (!hasConditions && data.length > this.multipartThreshold) {
      return this.multipartPut(key, data, opts?.contentType);
    }
    return withRetry(async () => {
      const res = await this.client.sendOk({
        method: "PUT",
        key,
        operation: "put",
        headers: {
          ...conditionalHeaders,
          ...(opts?.contentType !== undefined ? { "content-type": opts.contentType } : {}),
        },
        body: data,
      });
      return { etag: res.header("etag") ?? "" };
    }, this.retryOpts);
  }

  private async multipartPut(
    key: ObjectKey,
    data: Uint8Array,
    contentType?: string,
  ): Promise<PutResult> {
    const initiate = await withRetry(async () => {
      const res = await this.client.sendOk({
        method: "POST",
        key,
        query: { uploads: "" },
        operation: "multipart-initiate",
        headers: contentType !== undefined ? { "content-type": contentType } : {},
      });
      return parseInitiateMultipartUpload(res.text());
    }, this.retryOpts);
    if (initiate === null) {
      throw new SyncError("StorageTransient", `S3 multipart-initiate "${key}": no UploadId`);
    }

    try {
      const parts: { partNumber: number; etag: string }[] = [];
      for (let offset = 0, n = 1; offset < data.length; offset += this.partSize, n++) {
        const chunk = data.subarray(offset, Math.min(offset + this.partSize, data.length));
        const etag = await withRetry(async () => {
          const res = await this.client.sendOk({
            method: "PUT",
            key,
            query: { partNumber: String(n), uploadId: initiate },
            operation: `multipart-part-${n}`,
            body: chunk,
          });
          return res.header("etag") ?? "";
        }, this.retryOpts);
        parts.push({ partNumber: n, etag });
      }

      return await withRetry(async () => {
        const res = await this.client.sendOk({
          method: "POST",
          key,
          query: { uploadId: initiate },
          operation: "multipart-complete",
          headers: { "content-type": "application/xml" },
          body: buildCompleteMultipartUpload(parts),
        });
        const text = res.text();
        const embedded = embeddedErrorCode(text); // 200-with-error is a thing
        if (embedded !== null) {
          throw normalizeS3Error(res.status, embedded, key, "multipart-complete");
        }
        const m = /<ETag>([^<]+)<\/ETag>/.exec(text);
        return { etag: m?.[1]?.replaceAll("&quot;", '"') ?? "" };
      }, this.retryOpts);
    } catch (e) {
      // Best-effort abort so incomplete parts do not linger (and bill).
      await this.client
        .send({ method: "DELETE", key, query: { uploadId: initiate }, operation: "multipart-abort" })
        .catch(() => undefined);
      throw e;
    }
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    return withRetry(async () => {
      const res = await this.client.sendOk({ method: "GET", key, operation: "get" });
      return res.bytes();
    }, this.retryOpts);
  }

  async stat(key: ObjectKey): Promise<ObjectStat> {
    return withRetry(async () => {
      const res = await this.client.sendOk({ method: "HEAD", key, operation: "stat" });
      const lastModified = res.header("last-modified");
      return {
        key,
        size: Number(res.header("content-length") ?? "0"),
        etag: res.header("etag") ?? "",
        lastModified:
          lastModified !== null ? Math.floor(Date.parse(lastModified) / 1000) : 0,
      };
    }, this.retryOpts);
  }

  async *list(prefix: string): AsyncIterable<ObjectStat> {
    let continuationToken: string | null = null;
    do {
      const page = await withRetry(async () => {
        const query: Record<string, string> = {
          "list-type": "2",
          "encoding-type": "url",
          "max-keys": "1000",
          prefix,
        };
        if (continuationToken !== null) query["continuation-token"] = continuationToken;
        const res = await this.client.sendOk({
          method: "GET",
          key: "",
          query,
          operation: "list",
        });
        return parseListObjectsV2(res.text());
      }, this.retryOpts);
      for (const obj of page.contents) {
        yield { key: obj.key, size: obj.size, etag: obj.etag, lastModified: obj.lastModified };
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : null;
    } while (continuationToken !== null);
  }

  async delete(key: ObjectKey): Promise<void> {
    await withRetry(async () => {
      const res = await this.client.send({ method: "DELETE", key, operation: "delete" });
      // Idempotent by contract: a missing key is success (S3 returns 204 anyway).
      if (!res.ok && res.status !== 404) {
        throw normalizeS3Error(res.status, s3ErrorCode(res.text()), key, "delete");
      }
    }, this.retryOpts);
  }

  capabilities(): ProviderCapabilities {
    return {
      conditionalWrites: this.conditional,
      // Not probed (needs extra IAM permission); reported conservatively.
      objectVersioning: false,
      maxSinglePutBytes: this.multipartThreshold,
    };
  }
}

function randomHex(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One-time honest capability probe: create a throwaway object, then verify the
 * backend actually REJECTS (412) both a create-if-absent over it and a PUT with
 * a bogus If-Match. Backends that silently ignore the headers are reported as
 * conditionalWrites: false — never trusted on faith.
 */
export async function probeConditionalWrites(
  client: S3Client,
  retryOpts: RetryOptions,
): Promise<boolean> {
  const key = `.syncrypt-capability-probe-${randomHex(8)}`;
  const payload = new TextEncoder().encode("syncrypt capability probe — safe to delete");
  try {
    await withRetry(
      () => client.sendOk({ method: "PUT", key, operation: "probe-create", body: payload }),
      retryOpts,
    );

    const rejected = async (headers: Record<string, string>): Promise<boolean> => {
      const res = await withRetry(
        () => client.send({ method: "PUT", key, operation: "probe-conditional", headers, body: payload }),
        retryOpts,
      );
      if (res.ok) return false; // header ignored → no conditional support
      if (res.status === 412) return true;
      // 501/400/etc.: the backend refuses the header rather than honoring it.
      return false;
    };

    const ifNoneMatchHonored = await rejected({ "if-none-match": "*" });
    const ifMatchHonored = await rejected({ "if-match": '"syncrypt-bogus-etag"' });
    return ifNoneMatchHonored && ifMatchHonored;
  } finally {
    await client
      .send({ method: "DELETE", key, operation: "probe-cleanup" })
      .catch(() => undefined);
  }
}
