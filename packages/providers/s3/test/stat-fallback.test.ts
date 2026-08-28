// Some HTTP stacks cannot issue a HEAD — Obsidian's requestUrl() on Android
// fails one with "IOException Stream closed". stat() must notice and fall back
// to a byte-range GET, WITHOUT turning real answers (404, 403) into fallbacks.

import { describe, expect, it } from "vitest";

import { isSyncError } from "@syncrypt/core";

import { S3Storage } from "../src/index.js";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/index.js";
import type { S3Config } from "../src/config.js";

const BASE: Omit<S3Config, "transport"> = {
  endpoint: "http://s3.internal:9000",
  bucket: "stat-bucket",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "VERY-SECRET",
  conditionalWrites: false,
  retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
};

const respond = (
  status: number,
  headers: Record<string, string> = {},
  body = "",
): HttpResponse => ({ status, headers, body: new TextEncoder().encode(body) });

/** A transport that dies on HEAD the way Obsidian's Android one does. */
function androidLike(onGet: (req: HttpRequest) => HttpResponse): {
  transport: HttpTransport;
  seen: HttpRequest[];
} {
  const seen: HttpRequest[] = [];
  const transport: HttpTransport = (req) => {
    seen.push(req);
    if (req.method === "HEAD") {
      return Promise.reject(new Error("Request Failed. IOException Stream closed"));
    }
    return Promise.resolve(onGet(req));
  };
  return { transport, seen };
}

describe("stat() on a stack that cannot do HEAD", () => {
  it("falls back to a range GET and reads the size from Content-Range", async () => {
    const { transport, seen } = androidLike(() =>
      respond(206, {
        "content-range": "bytes 0-0/12345",
        "content-length": "1",
        etag: '"abc"',
        "last-modified": "Wed, 27 Aug 2026 10:00:00 GMT",
      }),
    );
    const storage = await S3Storage.create({ ...BASE, transport });

    const stat = await storage.stat("objects/4b/44/deadbeef");
    expect(stat.size).toBe(12345); // NOT the 1 byte actually transferred
    expect(stat.etag).toBe('"abc"');
    expect(stat.lastModified).toBe(Math.floor(Date.parse("Wed, 27 Aug 2026 10:00:00 GMT") / 1000));

    const range = seen.find((r) => r.method === "GET");
    expect(range?.headers.range ?? range?.headers.Range).toBe("bytes=0-0");
  });

  it("stops trying HEAD once it has failed — one request per stat afterwards", async () => {
    const { transport, seen } = androidLike(() =>
      respond(206, { "content-range": "bytes 0-0/7", etag: '"e"' }),
    );
    const storage = await S3Storage.create({ ...BASE, transport });

    await storage.stat("objects/a");
    const headsAfterFirst = seen.filter((r) => r.method === "HEAD").length;
    seen.length = 0;
    await storage.stat("objects/b");
    await storage.stat("objects/c");

    expect(headsAfterFirst).toBe(1);
    expect(seen.filter((r) => r.method === "HEAD")).toHaveLength(0);
    expect(seen.filter((r) => r.method === "GET")).toHaveLength(2);
  });

  it("reports an empty object (416) as size 0, not as an error", async () => {
    const { transport } = androidLike(() => respond(416, { etag: '"empty"' }));
    const storage = await S3Storage.create({ ...BASE, transport });
    const stat = await storage.stat("objects/empty");
    expect(stat.size).toBe(0);
    expect(stat.etag).toBe('"empty"');
  });

  it("uses Content-Length when the backend ignores Range and answers 200", async () => {
    const { transport } = androidLike(() => respond(200, { "content-length": "99", etag: '"e"' }));
    const storage = await S3Storage.create({ ...BASE, transport });
    expect((await storage.stat("objects/x")).size).toBe(99);
  });
});

describe("real answers are never mistaken for a broken HEAD", () => {
  it("keeps StorageNotFound for a missing object", async () => {
    const transport: HttpTransport = (req) =>
      Promise.resolve(
        req.method === "HEAD"
          ? respond(404)
          : respond(200, { "content-length": "1" }, "should not be used"),
      );
    const storage = await S3Storage.create({ ...BASE, transport });
    let caught: unknown;
    try {
      await storage.stat("objects/missing");
    } catch (e) {
      caught = e;
    }
    expect(isSyncError(caught, "StorageNotFound")).toBe(true);
  });

  it("surfaces the network error when the range GET fails too (really offline)", async () => {
    const transport: HttpTransport = () =>
      Promise.reject(new Error("Request Failed. IOException Stream closed"));
    const storage = await S3Storage.create({ ...BASE, transport });
    let caught: unknown;
    try {
      await storage.stat("objects/x");
    } catch (e) {
      caught = e;
    }
    expect(isSyncError(caught, "StorageTransient")).toBe(true);
  });
});
