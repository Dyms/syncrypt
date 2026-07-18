// WebDavStorage — StoragePort over plain WebDAV (RFC-0006 §Future providers).
//
// The protocol-different second provider that proves the abstraction:
// capabilities().conditionalWrites is FALSE — manifest safety rides entirely
// on the LIST-based protocol (ADR-0006), exercised end-to-end by the shared
// conformance suite and the encrypted e2e.
//
//   get    = GET            put  = PUT (+ MKCOL for missing parents on 409)
//   stat   = PROPFIND 0     list = PROPFIND Depth:1, walked recursively
//   delete = DELETE (404 = success — idempotent per RFC-0006)

import {
  SyncError,
  type ObjectKey,
  type ObjectStat,
  type ProviderCapabilities,
  type PutOptions,
  type PutResult,
  type StoragePort,
} from "@syncrypt/core";

import { WebDavClient, normalizeDavError } from "./client.js";
import { WEBDAV_DEFAULTS, type WebDavConfig } from "./config.js";
import { withRetry, type RetryOptions } from "./retry.js";
import { parseMultistatus, PROPFIND_BODY, type DavEntry } from "./xml.js";

export class WebDavStorage implements StoragePort {
  private readonly client: WebDavClient;
  private readonly retryOpts: RetryOptions;
  private readonly maxSinglePutBytes: number;

  constructor(config: WebDavConfig) {
    this.client = new WebDavClient(config);
    this.retryOpts = {
      maxRetries: config.retry?.maxRetries ?? WEBDAV_DEFAULTS.maxRetries,
      baseDelayMs: config.retry?.baseDelayMs ?? WEBDAV_DEFAULTS.baseDelayMs,
      maxDelayMs: config.retry?.maxDelayMs ?? WEBDAV_DEFAULTS.maxDelayMs,
    };
    this.maxSinglePutBytes = config.maxSinglePutBytes ?? WEBDAV_DEFAULTS.maxSinglePutBytes;
  }

  /** Symmetry with S3Storage.create (no probe needed here). */
  static create(config: WebDavConfig): Promise<WebDavStorage> {
    return Promise.resolve(new WebDavStorage(config));
  }

  async put(key: ObjectKey, data: Uint8Array, opts?: PutOptions): Promise<PutResult> {
    // ifMatch/ifNoneMatch are NOT consulted: conditionalWrites=false
    // (RFC-0006 — options only apply when the capability is advertised).
    return withRetry(async () => {
      let res = await this.client.send({
        method: "PUT",
        key,
        operation: "put",
        headers: opts?.contentType !== undefined ? { "content-type": opts.contentType } : {},
        body: data,
      });
      if (res.status === 409) {
        // Missing intermediate collections — create them and try once more.
        await this.mkcolRecursive(parentOf(key));
        res = await this.client.send({
          method: "PUT",
          key,
          operation: "put",
          headers: opts?.contentType !== undefined ? { "content-type": opts.contentType } : {},
          body: data,
        });
      }
      if (!res.ok) throw normalizeDavError(res.status, key, "put");
      const etag = res.header("etag");
      // Some servers omit the ETag on PUT — fetch it (conformance requires a
      // non-empty, content-sensitive etag in PutResult).
      return { etag: etag ?? (await this.stat(key)).etag };
    }, this.retryOpts);
  }

  private async mkcolRecursive(collection: string): Promise<void> {
    if (collection === "") return;
    const segments = collection.split("/");
    let current = "";
    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      const res = await this.client.send({ method: "MKCOL", key: current, operation: "mkcol" });
      // 201 created · 405 already exists · 301/302 some servers redirect
      if (!res.ok && res.status !== 405 && res.status !== 301 && res.status !== 302) {
        throw normalizeDavError(res.status, current, "mkcol");
      }
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
      const res = await this.client.sendOk({
        method: "PROPFIND",
        key,
        operation: "stat",
        headers: { depth: "0", "content-type": "application/xml" },
        body: PROPFIND_BODY,
      });
      const entry = parseMultistatus(res.text())[0];
      if (entry === undefined || entry.isCollection) {
        // A collection is not an object; report NotFound like S3 would.
        throw new SyncError("StorageNotFound", `WebDAV stat "${key}": not a file`);
      }
      return { key, size: entry.size, etag: entry.etag, lastModified: entry.lastModified };
    }, this.retryOpts);
  }

  async *list(prefix: string): AsyncIterable<ObjectStat> {
    // Start at the deepest collection the prefix implies, then filter by the
    // S3-style string prefix (a prefix is NOT necessarily a folder boundary).
    const startCollection = prefix.includes("/")
      ? prefix.slice(0, prefix.lastIndexOf("/"))
      : "";
    const found: ObjectStat[] = [];

    const walk = async (collection: string): Promise<void> => {
      const res = await withRetry(
        () =>
          this.client.send({
            method: "PROPFIND",
            key: collection,
            operation: "list",
            headers: { depth: "1", "content-type": "application/xml" },
            body: PROPFIND_BODY,
          }),
        this.retryOpts,
      );
      if (res.status === 404) return; // nothing under this prefix
      if (!res.ok) throw normalizeDavError(res.status, collection, "list");
      const entries: DavEntry[] = parseMultistatus(res.text());
      for (const entry of entries) {
        const key = this.client.keyFor(entry.path);
        if (key === collection) continue; // Depth:1 includes the collection itself
        if (entry.isCollection) {
          // Recurse only where the subtree can still match the prefix.
          if (key.startsWith(prefix) || prefix.startsWith(`${key}/`)) await walk(key);
        } else if (key.startsWith(prefix)) {
          found.push({
            key,
            size: entry.size,
            etag: entry.etag,
            lastModified: entry.lastModified,
          });
        }
      }
    };

    await walk(startCollection);
    for (const stat of found.sort((a, b) => (a.key < b.key ? -1 : 1))) yield stat;
  }

  async delete(key: ObjectKey): Promise<void> {
    await withRetry(async () => {
      const res = await this.client.send({ method: "DELETE", key, operation: "delete" });
      if (!res.ok && res.status !== 404) {
        throw normalizeDavError(res.status, key, "delete"); // 404 = idempotent success
      }
    }, this.retryOpts);
  }

  capabilities(): ProviderCapabilities {
    return {
      conditionalWrites: false, // by design — the ADR-0006 LIST protocol carries safety
      objectVersioning: false,
      maxSinglePutBytes: this.maxSinglePutBytes,
    };
  }
}

function parentOf(key: ObjectKey): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? "" : key.slice(0, slash);
}
