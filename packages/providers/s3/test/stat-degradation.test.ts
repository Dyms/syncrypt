// ADR-0056. stat() degrades HEAD → range GET → LIST, and REMEMBERS where it
// got to. Before this, "remembers" was driven by the error taxonomy alone:
// every unmapped status normalizes to StorageTransient, so a one-off 500
// looked exactly like a transport that cannot issue the request at all. One
// blip and the session paid for the slower shape until Obsidian restarted.
//
// The two halves under test: a transient failure must NOT stick, a definitive
// "this shape does not exist here" (501, or no answer at all) MUST, and a 416
// that carries no ETag must not be answered with an empty one.

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

const LIST_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>objects/cf/ca/deadbeef</Key>
    <Size>0</Size>
    <ETag>&quot;listed&quot;</ETag>
    <LastModified>2026-08-28T10:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

const isList = (req: HttpRequest): boolean => req.url.includes("list-type=2");

/**
 * Records every request and answers by a per-shape script. `nth` counts calls
 * of that shape for the life of the transport — tests clear `seen` between
 * stats, so it must not be derived from it.
 */
function scripted(
  answer: (req: HttpRequest, nth: number) => HttpResponse | Error,
): {
  transport: HttpTransport;
  seen: HttpRequest[];
} {
  const seen: HttpRequest[] = [];
  const counts = new Map<string, number>();
  const transport: HttpTransport = (req) => {
    seen.push(req);
    const shape = isList(req) ? "list" : req.method;
    const nth = (counts.get(shape) ?? 0) + 1;
    counts.set(shape, nth);
    const a = answer(req, nth);
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  return { transport, seen };
}

/** Requests that actually fetch the object — a LIST is a GET on the wire. */
const ranges = (seen: HttpRequest[]): HttpRequest[] =>
  seen.filter((r) => r.method === "GET" && !isList(r));

describe("a transient failure does not cost the session the faster shape", () => {
  it("A ONE-OFF 500 ON HEAD IS RETRIED ON THE NEXT STAT", async () => {
    const { transport, seen } = scripted((req, nth) => {
      if (req.method === "HEAD") {
        return nth === 1
          ? respond(500, {}, "<Error><Code>InternalError</Code></Error>")
          : respond(200, { "content-length": "12", etag: '"h"' });
      }
      return respond(206, { "content-range": "bytes 0-0/12", etag: '"r"' });
    });
    const storage = await S3Storage.create({ ...BASE, transport });

    // First stat: HEAD blips, the range GET answers.
    expect((await storage.stat("objects/a")).size).toBe(12);

    seen.length = 0;
    const second = await storage.stat("objects/b");

    expect(seen.filter((r) => r.method === "HEAD")).toHaveLength(1);
    expect(ranges(seen)).toHaveLength(0);
    expect(second.etag).toBe('"h"'); // answered by HEAD, not by the fallback
  });

  it("a 500 on the range GET does not pin the session to LIST either", async () => {
    const { transport, seen } = scripted((req, nth) => {
      if (isList(req)) return respond(200, {}, LIST_BODY);
      if (req.method === "HEAD")
        return new Error("Request Failed. IOException Stream closed");
      return nth === 1
        ? respond(503, {}, "<Error><Code>SlowDown2</Code></Error>")
        : respond(206, { "content-range": "bytes 0-0/9", etag: '"r"' });
    });
    const storage = await S3Storage.create({ ...BASE, transport });

    await storage.stat("objects/cf/ca/deadbeef"); // HEAD dies (sticky), range blips, LIST answers

    seen.length = 0;
    const second = await storage.stat("objects/cf/ca/deadbeef");

    // HEAD is gone for good — the transport cannot issue it. The range GET is
    // not: it answered with a status, so it is still the cheapest thing to try.
    expect(seen.filter((r) => r.method === "HEAD")).toHaveLength(0);
    expect(ranges(seen)).toHaveLength(1);
    expect(seen.filter(isList)).toHaveLength(0);
    expect(second.etag).toBe('"r"');
  });

  it("A PERMANENT FAILURE BEHIND A BLIP IS NOT REMEMBERED EITHER", async () => {
    // HEAD blips once; the range GET is genuinely unusable. What the session
    // remembers is an INDEX into the three shapes, so it can only express
    // "skip the first N" — remembering LIST here would silently give up the
    // HEAD that was about to work. It remembers nothing instead, and pays one
    // doomed range GET per stat until the session ends.
    const { transport, seen } = scripted((req, nth) => {
      if (isList(req)) return respond(200, {}, LIST_BODY);
      if (req.method === "HEAD") {
        return nth === 1
          ? respond(500, {}, "<Error><Code>InternalError</Code></Error>")
          : respond(200, { "content-length": "0", etag: '"h"' });
      }
      return new Error("Request Failed. IOException Stream closed");
    });
    const storage = await S3Storage.create({ ...BASE, transport });

    await storage.stat("objects/cf/ca/deadbeef");

    seen.length = 0;
    const second = await storage.stat("objects/cf/ca/deadbeef");

    expect(seen.filter((r) => r.method === "HEAD")).toHaveLength(1);
    expect(seen.filter(isList)).toHaveLength(0);
    expect(second.etag).toBe('"h"');
  });
});

describe("a definitive 'not implemented' is remembered", () => {
  it("A 501 ON HEAD STOPS THE SESSION FROM EVER SENDING ONE AGAIN", async () => {
    const { transport, seen } = scripted((req) =>
      req.method === "HEAD"
        ? respond(501, {}, "<Error><Code>NotImplemented</Code></Error>")
        : respond(206, { "content-range": "bytes 0-0/5", etag: '"r"' }),
    );
    const storage = await S3Storage.create({ ...BASE, transport });

    await storage.stat("objects/a");
    seen.length = 0;
    await storage.stat("objects/b");
    await storage.stat("objects/c");

    expect(seen.filter((r) => r.method === "HEAD")).toHaveLength(0);
    expect(seen.filter((r) => r.method === "GET")).toHaveLength(2);
  });
});

describe("a 416 that carries no ETag is not an answer", () => {
  it("FALLS THROUGH TO LIST INSTEAD OF REPORTING AN EMPTY ETAG", async () => {
    const { transport } = scripted((req) => {
      if (isList(req)) return respond(200, {}, LIST_BODY);
      if (req.method === "HEAD")
        return new Error("Request Failed. IOException Stream closed");
      return respond(416); // zero-byte object, no etag — what S3 really answers
    });
    const storage = await S3Storage.create({ ...BASE, transport });

    const stat = await storage.stat("objects/cf/ca/deadbeef");
    expect(stat.size).toBe(0);
    expect(stat.etag).toBe('"listed"'); // NOT ""
  });

  it("keeps the range GET as the remembered shape — only HEAD was unusable", async () => {
    const { transport, seen } = scripted((req) => {
      if (isList(req)) return respond(200, {}, LIST_BODY);
      if (req.method === "HEAD")
        return new Error("Request Failed. IOException Stream closed");
      return respond(416);
    });
    const storage = await S3Storage.create({ ...BASE, transport });

    await storage.stat("objects/cf/ca/deadbeef");
    seen.length = 0;
    await storage.stat("objects/cf/ca/deadbeef");

    // An empty object is a property of that object, not of the backend: the
    // next object may well be answerable by one cheap range GET.
    expect(seen.filter((r) => r.method === "HEAD")).toHaveLength(0);
    expect(seen.filter((r) => r.method === "GET" && !isList(r))).toHaveLength(
      1,
    );
  });

  it("still surfaces a transient failure when nothing can answer", async () => {
    const { transport } = scripted((req) =>
      isList(req)
        ? respond(500, {}, "<Error><Code>InternalError</Code></Error>")
        : req.method === "HEAD"
          ? new Error("Request Failed. IOException Stream closed")
          : respond(416),
    );
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
