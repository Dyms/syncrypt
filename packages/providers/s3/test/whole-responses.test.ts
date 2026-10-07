// A 2xx is not proof. A captive portal or a proxy answers 200 with a page, and
// a body can be cut off mid-stream; this provider used to believe both:
//   - a PUT answered 200 without an ETag was "stored";
//   - a LIST answered with HTML was an empty, complete listing, and one cut
//     after IsTruncated/NextContinuationToken lost the rest of its page.
// What reads a listing decides which generations exist and what is garbage.

import { describe, expect, it } from "vitest";

import { isSyncError } from "@syncrypt/core";

import type { S3Config } from "../src/config.js";
import { S3Storage } from "../src/index.js";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/transport.js";
import { parseListObjectsV2 } from "../src/xml.js";

const BASE: Omit<S3Config, "transport"> = {
  endpoint: "http://s3.internal:9000",
  bucket: "b",
  accessKeyId: "AK",
  secretAccessKey: "SK",
  conditionalWrites: false,
  retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
};
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const reply = (status: number, body: string, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body: enc(body),
});
const row = (k: string): string =>
  `<Contents><Key>${k}</Key><Size>7</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;e&quot;</ETag></Contents>`;
const whole = (rows: string, extra = ""): string =>
  `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${extra}${rows}</ListBucketResult>`;

async function keys(it: AsyncIterable<{ key: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of it) out.push(s.key);
  return out;
}

async function transient(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return isSyncError(e, "StorageTransient");
  }
}

describe("PUT without an ETag must be confirmed", () => {
  const make = (head: (req: HttpRequest) => HttpResponse): Promise<S3Storage> =>
    S3Storage.create({
      ...BASE,
      transport: (req) =>
        Promise.resolve(req.method === "PUT" ? reply(200, "<html>sign in</html>") : head(req)),
    });

  it("a page where the object should be is refused", async () => {
    const s = await make(() => reply(404, ""));
    await expect(s.put("objects/aa/x", enc("data"))).rejects.toSatisfy(
      (e: unknown) => isSyncError(e, "StorageNotFound") || isSyncError(e, "StorageTransient"),
    );
  });

  it("an object at the wrong length is refused", async () => {
    const s = await make(() => reply(200, "", { "content-length": "2", etag: '"e"' }));
    expect(await transient(s.put("objects/aa/x", enc("data")))).toBe(true);
  });

  it("an object that is there at the right length is accepted, with its ETag", async () => {
    const s = await make(() => reply(200, "", { "content-length": "4", etag: '"abc"' }));
    const r = await s.put("objects/aa/x", enc("data"));
    expect(r.etag).toBe('"abc"');
  });

  it("an ETag in the PUT answer needs no second request", async () => {
    let heads = 0;
    const transport: HttpTransport = (req) => {
      if (req.method === "HEAD") heads++;
      return Promise.resolve(req.method === "PUT" ? reply(200, "", { etag: '"fast"' }) : reply(404, ""));
    };
    const s = await S3Storage.create({ ...BASE, transport });
    expect((await s.put("objects/aa/x", enc("data"))).etag).toBe('"fast"');
    expect(heads).toBe(0);
  });
});

describe("a completed multipart upload without an ETag must be confirmed", () => {
  const make = (head: (req: HttpRequest) => HttpResponse): Promise<S3Storage> =>
    S3Storage.create({
      ...BASE,
      multipartThresholdBytes: 4,
      partSizeBytes: 4,
      transport: (req) => {
        if (req.method === "POST" && req.url.includes("uploads=")) {
          return Promise.resolve(reply(200, "<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>"));
        }
        if (req.method === "PUT") return Promise.resolve(reply(200, "", { etag: '"part"' }));
        if (req.method === "POST") return Promise.resolve(reply(200, "<html>sign in</html>"));
        if (req.method === "DELETE") return Promise.resolve(reply(204, ""));
        return Promise.resolve(head(req));
      },
    });

  it("a page in place of the completion answer is refused", async () => {
    const s = await make(() => reply(404, ""));
    await expect(s.put("objects/aa/x", enc("0123456789"))).rejects.toBeDefined();
  });

  it("the stored object at the right length is accepted", async () => {
    const s = await make(() => reply(200, "", { "content-length": "10", etag: '"whole"' }));
    expect((await s.put("objects/aa/x", enc("0123456789"))).etag).toBe('"whole"');
  });
});

describe("a LIST is believed only as a whole document", () => {
  const storage = (pages: string[]): Promise<S3Storage> => {
    let i = 0;
    return S3Storage.create({
      ...BASE,
      transport: () => Promise.resolve(reply(200, pages[Math.min(i++, pages.length - 1)] ?? "")),
    });
  };

  it("a proxy page is not an empty listing", async () => {
    const s = await storage(["<html><body>Log in to the network</body></html>"]);
    expect(await transient(keys(s.list("manifests/")))).toBe(true);
  });

  it("an empty answer body is not an empty listing", async () => {
    const s = await storage([""]);
    expect(await transient(keys(s.list("manifests/")))).toBe(true);
  });

  it("a body cut inside a page does not lose the rest of the page", async () => {
    const cut =
      `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken>` +
      row("manifests/000000001-a.json") +
      `<Contents><Key>manifests/00000`;
    const s = await storage([cut, whole(row("manifests/000000009-a.json"))]);
    expect(await transient(keys(s.list("manifests/")))).toBe(true);
  });

  it("a well-formed listing still lists, empty or not, with or without a namespace prefix", async () => {
    expect(await keys((await storage([whole("")])).list("manifests/"))).toEqual([]);
    expect(await keys((await storage([whole(row("manifests/1-a.json"))])).list("manifests/"))).toEqual([
      "manifests/1-a.json",
    ]);
    const prefixed = `<s3:ListBucketResult xmlns:s3="x"><s3:IsTruncated>false</s3:IsTruncated></s3:ListBucketResult>`;
    expect(parseListObjectsV2(prefixed).contents).toEqual([]);
    expect(parseListObjectsV2(`<ListBucketResult xmlns="x"/>`).contents).toEqual([]);
    expect(() => parseListObjectsV2(whole("") + "\n")).not.toThrow();
    // A closing tag alone is not a document.
    expect(() => parseListObjectsV2("not xml</ListBucketResult>")).toThrow();
  });
});
