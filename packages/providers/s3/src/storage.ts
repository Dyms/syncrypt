// S3Storage — StoragePort over any S3-compatible backend (RFC-0006).
//
// The engine's manifest concurrency is LIST-based and provider-agnostic
// (ADR-0006 + erratum); this provider only implements the universal subset
// honestly. Conditional writes are probed once at create() and honored on
// single PUTs when supported; multipart handles large objects; Transient and
// RateLimited failures retry with backoff + jitter.

import {
  isSyncError,
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
import { S3RequestError, normalizeS3Error, s3ErrorCode } from "./errors.js";
import { withRetry, type RetryOptions } from "./retry.js";
import {
  buildCompleteMultipartUpload,
  embeddedErrorCode,
  parseInitiateMultipartUpload,
  parseListObjectsV2,
} from "./xml.js";

export class S3Storage implements StoragePort {
  /**
   * How stat() asks. Starts at HEAD and degrades permanently (per session) the
   * first time a shape of request fails at transport level — some stacks
   * cannot do HEAD (Obsidian on Android), and a hostile proxy could break the
   * range GET too. LIST is the last resort: it is the same request the engine
   * already makes everywhere else, so if that fails the storage really is
   * unreachable.
   */
  private statStrategy: StatStrategy = "head";

  private constructor(
    private readonly client: S3Client,
    private readonly conditional: boolean,
    private readonly multipartThreshold: number,
    private readonly partSize: number,
    private readonly retryOpts: RetryOptions,
    private readonly listPageSize: number,
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
      mode === "probe"
        ? await probeConditionalWrites(client, retryOpts, probeKey(config.vaultPrefix))
        : mode;
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
      Math.min(Math.max(1, Math.floor(config.listPageSize ?? S3_DEFAULTS.listPageSize)), 1000),
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

  /**
   * HEAD is the natural way to stat an object, but not every HTTP stack can
   * issue one: Obsidian's `requestUrl()` on Android fails a HEAD with
   * "IOException Stream closed" (it expects a body). Rather than shipping a
   * platform flag, we DETECT it: the first transport-level failure of a HEAD
   * switches this storage to a byte-range GET for the rest of the session.
   *
   * A 404 stays a 404 and a 403 stays a 403 — those are answers, not broken
   * plumbing, and they end the call rather than changing its shape.
   *
   * What the session REMEMBERS is narrower than what makes it fall through.
   * Falling through is worth doing on any transient failure: a gateway that
   * answers 500 once should still get its object stat'd. Remembering is only
   * honest when the failure was a PERMANENT property of this backend — the
   * transport unable to issue this shape at all (Android and HEAD), or a 501
   * "not implemented". Before ADR-0056 every unmapped status, 500s and 400s
   * included, normalized to StorageTransient and stuck: one blip and the
   * session used the slower shape until Obsidian restarted — and on Android
   * that shape is the one whose zero-byte answer carries no etag.
   */
  async stat(key: ObjectKey): Promise<ObjectStat> {
    const strategies: [StatStrategy, (k: ObjectKey) => Promise<ObjectStat>][] = [
      ["head", (k) => this.statViaHead(k)],
      ["range", (k) => this.statViaRange(k)],
      ["list", (k) => this.statViaList(k)],
    ];
    const start = strategies.findIndex(([name]) => name === this.statStrategy);
    let firstError: SyncError | null = null;
    // True while every shape tried so far failed PERMANENTLY. The session
    // remembers exactly the leading run of unusable shapes and nothing past it:
    // one transient failure ends the run, so a 500 blip cannot cost the session
    // the cheaper request for the rest of the session (ADR-0056).
    let leadingRun = true;

    for (let i = Math.max(start, 0); i < strategies.length; i++) {
      const entry = strategies[i];
      if (entry === undefined) continue;
      const [name, run] = entry;
      try {
        return await withRetry(() => run(key), this.retryOpts);
      } catch (e) {
        // A definitive answer (404, 403, …) is the answer — never a reason to
        // try another shape of request.
        if (!isSyncError(e, "StorageTransient")) throw e;
        // The memory is an INDEX into the shapes, so it can only say "skip the
        // first N": it advances only while every failure so far was permanent.
        const permanent = e instanceof S3RequestError && (e.status === null || e.status === 501);
        if (leadingRun && permanent) {
          this.statStrategy = strategies[i + 1]?.[0] ?? name;
        } else {
          leadingRun = false;
        }
        firstError ??= e instanceof SyncError ? e : null;
      }
    }
    throw (
      firstError ??
      new SyncError("StorageTransient", `S3 stat "${key}": every request shape failed`)
    );
  }

  private async statViaHead(key: ObjectKey): Promise<ObjectStat> {
    const res = await this.client.sendOk({ method: "HEAD", key, operation: "stat(head)" });
    return {
      key,
      size: Number(res.header("content-length") ?? "0"),
      etag: res.header("etag") ?? "",
      lastModified: parseHttpDate(res.header("last-modified")),
    };
  }

  /**
   * Stat without HEAD: ask for the first byte and read the total size out of
   * `Content-Range: bytes 0-0/12345`. One request, one byte of transfer. A
   * zero-byte object answers 416 — a successful stat of an empty object, not
   * an error.
   */
  private async statViaRange(key: ObjectKey): Promise<ObjectStat> {
    const res = await this.client.send({
      method: "GET",
      key,
      headers: { range: "bytes=0-0" },
      operation: "stat(range)",
    });
    if (res.status === 416) {
      // A zero-byte object: a successful stat, not an error. But S3 answers 416
      // without an ETag, and `ObjectStat.etag` is what conditional writes
      // compare against — the conformance suite requires it non-empty.
      // Inventing one is worse than admitting this shape cannot answer here, so
      // fall through to the next strategy (ADR-0056).
      const etag = res.header("etag");
      if (etag === null || etag === "") {
        throw new S3RequestError(
          "StorageTransient",
          `S3 stat(range) "${key}": HTTP 416 carries no ETag for a zero-byte object`,
          res.status,
        );
      }
      return {
        key,
        size: 0,
        etag,
        lastModified: parseHttpDate(res.header("last-modified")),
      };
    }
    if (!res.ok) {
      throw normalizeS3Error(res.status, s3ErrorCode(res.text()), key, "stat(range)");
    }
    const contentRange = res.header("content-range");
    const total = contentRange === null ? null : TOTAL_AFTER_SLASH.exec(contentRange)?.[1];
    return {
      key,
      // 206 → the size after the slash; 200 (Range ignored) → content-length.
      size: Number(total ?? res.header("content-length") ?? "0"),
      etag: res.header("etag") ?? "",
      lastModified: parseHttpDate(res.header("last-modified")),
    };
  }

  /**
   * Last-resort stat: a one-key LIST. No HEAD, no Range — exactly the request
   * shape the engine uses to read the manifest, so it works wherever anything
   * works at all. An empty page means the object is not there.
   */
  private async statViaList(key: ObjectKey): Promise<ObjectStat> {
    for await (const stat of this.list(key)) {
      if (stat.key === key) return stat;
    }
    throw new SyncError("StorageNotFound", `S3 stat(list) "${key}": HTTP 404`);
  }

  /**
   * List every key under a prefix. The paging here is answered by the server,
   * so all three ways it can lie are refused rather than believed (ADR-0039).
   */
  async *list(prefix: string): AsyncIterable<ObjectStat> {
    let continuationToken: string | null = null;
    let pages = 0;
    const seenTokens = new Set<string>();
    for (;;) {
      if (++pages > MAX_LIST_PAGES) {
        throw new SyncError(
          "StorageTransient",
          `S3 list "${prefix}": more than ${String(MAX_LIST_PAGES)} pages — refusing to keep listing`,
        );
      }
      const page = await withRetry(async () => {
        const query: Record<string, string> = {
          "list-type": "2",
          "encoding-type": "url",
          "max-keys": String(this.listPageSize),
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
        // A listing answers about the prefix it was asked about. A key outside
        // it is the server volunteering something else, and every caller here
        // hands these keys to stat(), get() and delete().
        if (!obj.key.startsWith(prefix)) continue;
        yield { key: obj.key, size: obj.size, etag: obj.etag, lastModified: obj.lastModified };
      }

      if (!page.isTruncated) return;
      const next = page.nextContinuationToken;
      // "There is more" with nothing to ask for it with. Stopping here would
      // report a PARTIAL listing as a complete one: a generation lower than
      // the vault's real one on manifests/, and a retained-generation set
      // computed from half the manifests when reclaiming.
      if (next === null || next === "") {
        throw new SyncError(
          "StorageTransient",
          `S3 list "${prefix}": truncated with no continuation token — the listing is incomplete`,
        );
      }
      // The same token twice is a loop. Empty pages never yield, so the
      // abort checks in readRemote and listObjects never get control and the
      // sync cannot even be cancelled.
      if (seenTokens.has(next)) {
        throw new SyncError(
          "StorageTransient",
          `S3 list "${prefix}": the server repeated a continuation token — refusing to loop`,
        );
      }
      seenTokens.add(next);
      continuationToken = next;
    }
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
  key: ObjectKey = probeKey(undefined),
): Promise<boolean> {
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

/**
 * Where the throwaway probe object goes: inside this vault, under `meta/`.
 *
 * `meta/` rather than `objects/` because everything under `objects/` is content
 * the reclamation planner reasons about, and rather than the bucket root
 * because that is outside what a prefix-scoped credential may write (ADR-0056).
 * It is deleted in a `finally`; a process killed mid-probe leaves one behind,
 * where it is at least obviously ours and obviously disposable.
 */
export function probeKey(vaultPrefix: string | undefined): ObjectKey {
  const prefix = (vaultPrefix ?? "").replace(/\/+$/, "");
  const relative = `meta/capability-probe-${randomHex(8)}`;
  return prefix === "" ? relative : `${prefix}/${relative}`;
}

type StatStrategy = "head" | "range" | "list";

/**
 * A backstop on the number of LIST pages one call may fetch. The repeated-token
 * check above is what actually catches a looping server; this catches the one
 * that cycles through fresh tokens for ever. At 1000 keys a page it is far
 * above any real vault.
 */
const MAX_LIST_PAGES = 100_000;

/** "bytes 0-0/12345" → 12345 */
const TOTAL_AFTER_SLASH = /\/(\d+)\s*$/;

function parseHttpDate(value: string | null): number {
  if (value === null) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}
