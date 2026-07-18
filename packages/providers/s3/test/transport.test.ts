// The transport seam (RFC-0006 §Injectable transport): signing is decoupled
// from dispatch. A custom transport receives the FULLY SIGNED request and its
// responses flow back through the normal error taxonomy.

import { describe, expect, it } from "vitest";

import { isSyncError } from "@syncrypt/core";

import { S3Storage } from "../src/index.js";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/index.js";
import type { S3Config } from "../src/config.js";

const BASE: Omit<S3Config, "transport"> = {
  endpoint: "http://s3.internal:9000",
  bucket: "seam-bucket",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "VERY-SECRET",
  conditionalWrites: false,
  retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
};

function respond(status: number, headers: Record<string, string> = {}, body = ""): HttpResponse {
  return { status, headers, body: new TextEncoder().encode(body) };
}

describe("injectable transport seam", () => {
  it("hands the transport a signed request with the exact body bytes", async () => {
    const seen: HttpRequest[] = [];
    const transport: HttpTransport = (req) => {
      seen.push(req);
      return Promise.resolve(respond(200, { etag: '"e1"' }));
    };
    const storage = await S3Storage.create({ ...BASE, transport });
    const payload = new Uint8Array([1, 2, 3, 250]);
    await storage.put("objects/ab/key", payload, { contentType: "application/octet-stream" });

    expect(seen).toHaveLength(1);
    const req = seen[0];
    if (req === undefined) return;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("http://s3.internal:9000/seam-bucket/objects/ab/key");
    // SigV4 signing happened BEFORE dispatch:
    expect(req.headers.authorization ?? req.headers.Authorization).toContain("AWS4-HMAC-SHA256");
    const sha = Object.entries(req.headers).find(([k]) => k.toLowerCase() === "x-amz-content-sha256");
    expect(sha?.[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(req.headers["content-type"] ?? req.headers["Content-Type"]).toBe("application/octet-stream");
    expect(req.body).toEqual(payload);
  });

  it("routes GET/stat responses (status, headers, body) back through the provider", async () => {
    const transport: HttpTransport = (req) => {
      if (req.method === "GET") return Promise.resolve(respond(200, {}, "file-content"));
      if (req.method === "HEAD") {
        return Promise.resolve(
          respond(200, {
            "content-length": "12",
            etag: '"abc"',
            "last-modified": "Wed, 16 Jul 2026 12:00:00 GMT",
          }),
        );
      }
      return Promise.resolve(respond(500));
    };
    const storage = await S3Storage.create({ ...BASE, transport });
    expect(new TextDecoder().decode(await storage.get("k"))).toBe("file-content");
    const stat = await storage.stat("k");
    expect(stat.size).toBe(12);
    expect(stat.etag).toBe('"abc"');
    expect(stat.lastModified).toBe(Math.floor(Date.parse("2026-07-16T12:00:00Z") / 1000));
  });

  it("error statuses from the transport normalize to the RFC-0007 taxonomy", async () => {
    const transport: HttpTransport = () =>
      Promise.resolve(respond(404, {}, "<Error><Code>NoSuchKey</Code></Error>"));
    const storage = await S3Storage.create({ ...BASE, transport });
    await expect(storage.get("missing")).rejects.toSatisfy((e) =>
      isSyncError(e, "StorageNotFound"),
    );
  });

  it("a throwing transport (network failure) normalizes to StorageTransient", async () => {
    const transport: HttpTransport = () => Promise.reject(new Error("socket hangup"));
    const storage = await S3Storage.create({ ...BASE, transport });
    await expect(storage.get("k")).rejects.toSatisfy((e) =>
      isSyncError(e, "StorageTransient"),
    );
  });
});
