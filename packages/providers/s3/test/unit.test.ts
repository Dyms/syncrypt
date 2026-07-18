// Unit tests over a MOCKED global fetch: error normalization, retry/backoff,
// XML parsing, the capability probe, and the no-credential-leak guarantee.
// Live-backend behavior is covered by conformance.test.ts against MinIO.

import { afterEach, describe, expect, it, vi } from "vitest";

import { isSyncError, SyncError } from "@syncrypt/core";

import {
  buildCompleteMultipartUpload,
  embeddedErrorCode,
  parseInitiateMultipartUpload,
  parseListObjectsV2,
  xmlUnescape,
} from "../src/xml.js";
import { normalizeS3Error, s3ErrorCode } from "../src/errors.js";
import { withRetry } from "../src/retry.js";
import { probeConditionalWrites, S3Storage } from "../src/storage.js";
import { S3Client } from "../src/client.js";
import type { S3Config } from "../src/config.js";

const SECRET = "VERY-SECRET-ACCESS-KEY-abc123";
const CONFIG: S3Config = {
  endpoint: "http://127.0.0.1:9000",
  bucket: "test-bucket",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: SECRET,
  retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
};

type MockHandler = (req: Request) => Response | Promise<Response>;

function mockFetch(handler: MockHandler): void {
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return handler(req);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("error normalization (RFC-0006 error contract)", () => {
  const cases: [number, string | null, string][] = [
    [404, null, "StorageNotFound"],
    [404, "NoSuchKey", "StorageNotFound"],
    [200, "NoSuchKey", "StorageNotFound"], // code wins over status
    [412, null, "StoragePreconditionFailed"],
    [409, "PreconditionFailed", "StoragePreconditionFailed"],
    [401, null, "StorageUnauthorized"],
    [403, "AccessDenied", "StorageUnauthorized"],
    [400, "SignatureDoesNotMatch", "StorageUnauthorized"],
    [429, null, "StorageRateLimited"],
    [503, "SlowDown", "StorageRateLimited"],
    [500, "InternalError", "StorageTransient"],
    [502, null, "StorageTransient"],
  ];
  it.each(cases)("HTTP %s / %s → %s", (status, code, expected) => {
    const e = normalizeS3Error(status, code, "some/key", "get");
    expect(e).toBeInstanceOf(SyncError);
    expect(e.code).toBe(expected);
    expect(e.message).toContain("some/key");
  });

  it("extracts <Code> from S3 error bodies", () => {
    expect(s3ErrorCode("<Error><Code>NoSuchKey</Code><Message>x</Message></Error>")).toBe("NoSuchKey");
    expect(s3ErrorCode("not xml")).toBeNull();
  });
});

describe("withRetry (backoff + jitter)", () => {
  const opts = {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 450,
    random: () => 1, // deterministic: always the ceiling
    sleep: vi.fn((_ms: number) => Promise.resolve()),
  };

  it("retries Transient with exponential, capped delays, then succeeds", async () => {
    opts.sleep.mockClear();
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls <= 3) throw new SyncError("StorageTransient", "boom");
      return Promise.resolve("ok");
    }, opts);
    expect(result).toBe("ok");
    expect(opts.sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 400]);
  });

  it("gives up after maxRetries and rethrows the typed error", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls++;
        throw new SyncError("StorageRateLimited", "slow down");
      }, opts),
    ).rejects.toSatisfy((e) => isSyncError(e, "StorageRateLimited"));
    expect(calls).toBe(4); // 1 + maxRetries
  });

  it("does not retry definitive answers", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls++;
        throw new SyncError("StorageNotFound", "nope");
      }, opts),
    ).rejects.toSatisfy((e) => isSyncError(e, "StorageNotFound"));
    expect(calls).toBe(1);
  });
});

describe("XML parsing (ADR-0015)", () => {
  it("parses ListObjectsV2 with url-encoded keys and pagination", () => {
    const xml = `<?xml version="1.0"?><ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>tok%2B1</NextContinuationToken>
      <Contents><Key>dir/nested%20file.md</Key><Size>42</Size>
        <ETag>&quot;abc123&quot;</ETag>
        <LastModified>2026-07-16T12:00:00.000Z</LastModified></Contents>
      <Contents><Key>%D1%80%D0%B5%D0%B7%D1%8E%D0%BC%D0%B5.md</Key><Size>7</Size>
        <ETag>&quot;def&quot;</ETag>
        <LastModified>2026-07-16T12:00:01.000Z</LastModified></Contents>
    </ListBucketResult>`;
    const page = parseListObjectsV2(xml);
    expect(page.isTruncated).toBe(true);
    expect(page.nextContinuationToken).toBe("tok%2B1");
    expect(page.contents.map((c) => c.key)).toEqual(["dir/nested file.md", "резюме.md"]);
    expect(page.contents[0]?.etag).toBe('"abc123"');
    expect(page.contents[0]?.size).toBe(42);
    expect(page.contents[0]?.lastModified).toBe(Math.floor(Date.parse("2026-07-16T12:00:00Z") / 1000));
  });

  it("multipart helpers round-trip", () => {
    expect(parseInitiateMultipartUpload("<InitiateMultipartUploadResult><UploadId>u-1</UploadId></InitiateMultipartUploadResult>")).toBe("u-1");
    expect(buildCompleteMultipartUpload([{ partNumber: 1, etag: '"a"' }, { partNumber: 2, etag: '"b"' }]))
      .toBe('<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag></Part></CompleteMultipartUpload>');
    expect(embeddedErrorCode("<Error><Code>InternalError</Code></Error>")).toBe("InternalError");
    expect(embeddedErrorCode("<CompleteMultipartUploadResult><ETag>x</ETag></CompleteMultipartUploadResult>")).toBeNull();
  });

  it("xmlUnescape handles entity ordering", () => {
    expect(xmlUnescape("&amp;lt;")).toBe("&lt;");
    expect(xmlUnescape("a&amp;b&lt;c&gt;d&quot;e")).toBe('a&b<c>d"e');
  });
});

describe("capability probe (honest reporting)", () => {
  const retry = { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 };

  function probeBackend(honorsConditions: boolean): MockHandler {
    return (req) => {
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      if (req.method === "PUT") {
        const conditional = req.headers.has("if-none-match") || req.headers.has("if-match");
        if (conditional && honorsConditions) return new Response("", { status: 412 });
        return new Response(null, { status: 200, headers: { etag: '"e1"' } });
      }
      return new Response("", { status: 500 });
    };
  }

  it("reports true only when the backend actually rejects violated conditions", async () => {
    mockFetch(probeBackend(true));
    expect(await probeConditionalWrites(new S3Client(CONFIG), retry)).toBe(true);

    mockFetch(probeBackend(false)); // backend silently ignores the headers
    expect(await probeConditionalWrites(new S3Client(CONFIG), retry)).toBe(false);
  });

  it("cleans up its probe object", async () => {
    const deleted: string[] = [];
    mockFetch((req) => {
      if (req.method === "DELETE") {
        deleted.push(new URL(req.url).pathname);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 200, headers: { etag: '"e"' } });
    });
    await probeConditionalWrites(new S3Client(CONFIG), retry);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain(".syncrypt-capability-probe-");
  });
});

describe("no credential leaks", () => {
  it("errors carry status/code/key but never the secret key or auth header", async () => {
    mockFetch((req) => {
      // The signed request itself must carry auth — but errors must not echo it.
      expect(req.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
      return new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", { status: 403 });
    });
    const storage = await S3Storage.create({ ...CONFIG, conditionalWrites: false });
    try {
      await storage.get("some/key");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isSyncError(e, "StorageUnauthorized"), String(e)).toBe(true);
      const text = `${(e as Error).message} ${(e as Error).stack ?? ""}`;
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("AWS4-HMAC-SHA256");
      expect(text).toContain("SignatureDoesNotMatch");
    }
  });
});

describe("storage over mocked fetch", () => {
  it("get retries a transient 500 and then succeeds", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      if (calls <= 2) return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    const storage = await S3Storage.create({ ...CONFIG, conditionalWrites: false });
    expect(await storage.get("k")).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toBe(3);
  });

  it("multipart protocol: initiate → parts → complete (and abort on failure)", async () => {
    const log: string[] = [];
    mockFetch(async (req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        log.push("initiate");
        return new Response("<InitiateMultipartUploadResult><UploadId>u-7</UploadId></InitiateMultipartUploadResult>");
      }
      if (req.method === "PUT" && url.searchParams.has("partNumber")) {
        log.push(`part-${url.searchParams.get("partNumber")} uploadId=${url.searchParams.get("uploadId")}`);
        return new Response(null, { status: 200, headers: { etag: `"p${url.searchParams.get("partNumber")}"` } });
      }
      if (req.method === "POST" && url.searchParams.has("uploadId")) {
        log.push(`complete: ${await req.text()}`);
        return new Response('<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>');
      }
      return new Response("", { status: 500 });
    });
    const storage = await S3Storage.create({
      ...CONFIG,
      conditionalWrites: false,
      multipartThresholdBytes: 4, // force multipart for a tiny payload
    });
    const result = await storage.put("big/object", new Uint8Array(10).fill(7));
    expect(result.etag).toBe('"final"');
    expect(log[0]).toBe("initiate");
    expect(log.some((l) => l.startsWith("part-1 uploadId=u-7"))).toBe(true);
    expect(log.at(-1)).toContain("<PartNumber>1</PartNumber>");
  });

  it("multipart aborts the upload when a part fails permanently", async () => {
    let aborted = false;
    mockFetch((req) => {
      const url = new URL(req.url);
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        return new Response("<InitiateMultipartUploadResult><UploadId>u-8</UploadId></InitiateMultipartUploadResult>");
      }
      if (req.method === "PUT" && url.searchParams.has("partNumber")) {
        return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      }
      if (req.method === "DELETE" && url.searchParams.has("uploadId")) {
        aborted = true;
        return new Response(null, { status: 204 });
      }
      return new Response("", { status: 500 });
    });
    const storage = await S3Storage.create({
      ...CONFIG,
      conditionalWrites: false,
      multipartThresholdBytes: 4,
    });
    await expect(storage.put("big/object", new Uint8Array(10))).rejects.toSatisfy((e) =>
      isSyncError(e, "StorageUnauthorized"),
    );
    expect(aborted).toBe(true);
  });
});
