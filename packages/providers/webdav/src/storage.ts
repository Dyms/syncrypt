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
      // The FIRST row that is actually about the key we asked for. A server
      // may answer with rows for other resources, and a row it marked 404 is
      // dropped by the parser — either way "some row came back" is not proof
      // the object exists, and this probe is what the deduplicator trusts when
      // it decides not to upload a file (ADR-0039).
      const entry = parseMultistatus(res.text()).find(
        (e) => this.client.keyFor(e.path) === key,
      );
      if (entry === undefined || entry.isCollection || !entry.described) {
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
    // The tree comes from the server, so it is not necessarily a tree: two
    // collections can name each other as children, and a generated one can go
    // down for ever. Neither is a legal answer, but "hangs the sync" is not an
    // acceptable way to find that out (ADR-0039).
    const visited = new Set<string>();

    const walk = async (collection: string): Promise<void> => {
      if (visited.has(collection)) return;
      visited.add(collection);
      if (visited.size > MAX_COLLECTIONS) {
        throw new SyncError(
          "StorageTransient",
          `WebDAV list "${prefix}": more than ${String(MAX_COLLECTIONS)} collections — refusing to keep walking`,
        );
      }
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
      // A 404 means "this collection is not there", which is a real answer
      // for the collection we STARTED at — an empty vault, a prefix nothing
      // has been written under yet. It is not an answer for a collection the
      // server itself just told us exists: that is the server contradicting
      // itself, and treating it as "empty" is how an error becomes a shorter
      // list (ADR-0043). Every other provider raises here.
      if (res.status === 404) {
        if (collection === startCollection) return;
        throw normalizeDavError(res.status, collection, "list");
      }
      if (!res.ok) throw normalizeDavError(res.status, collection, "list");
      const entries: DavEntry[] = parseMultistatus(res.text());
      for (const entry of entries) {
        const key = this.client.keyFor(entry.path);
        // Not inside our collection, or a traversing path: the server's
        // problem, not our object (ADR-0039).
        if (key === null) continue;
        if (key === collection) continue; // Depth:1 includes the collection itself
        if (entry.isCollection) {
          // Recurse only where the subtree can still match the prefix.
          if (key.startsWith(prefix) || prefix.startsWith(`${key}/`)) await walk(key);
        } else if (entry.described && key.startsWith(prefix)) {
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
      if (res.status === 404) return; // idempotent success
      // 207 is "here is what happened to each resource", and some of it may be
      // a failure. Reporting the object gone when the server said otherwise
      // leaves the caller believing storage was reclaimed that was not.
      if (res.status === 207 && failedInMultistatus(res.text())) {
        throw normalizeDavError(207, key, "delete");
      }
      if (!res.ok) throw normalizeDavError(res.status, key, "delete");
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

/**
 * How many collections one list() will walk. Large enough for any real vault
 * (objects/ is two hex levels — 65 536 at the very most, and only ever the
 * ones that exist), small enough that a server generating an endless tree
 * fails instead of hanging.
 */
const MAX_COLLECTIONS = 100_000;

/** Any non-2xx row in a multistatus body — the server saying part of it failed. */
function failedInMultistatus(xml: string): boolean {
  for (const m of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?status[^>]*>([^<]*)</gi)) {
    const code = /\s(\d{3})\s/.exec(` ${(m[1] ?? "").trim()} `)?.[1];
    if (code !== undefined && !(Number(code) >= 200 && Number(code) < 300)) return true;
  }
  return false;
}

function parentOf(key: ObjectKey): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? "" : key.slice(0, slash);
}
