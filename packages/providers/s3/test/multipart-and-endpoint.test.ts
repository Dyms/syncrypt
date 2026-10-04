// ADR-0060. Seven findings that are not data loss, in the parts of the code
// that get read least: a temp file published as a note, an endpoint path
// thrown away, two numbers in one ADR that contradict each other, a button
// that looked like a check and wrote, a journal the caller could edit, a type
// that stopped being updated — and one request this provider retries that
// cannot be retried safely.

import { describe, expect, it } from "vitest";

import { isSyncError } from "@syncrypt/core";

import { S3Client, S3Storage } from "../src/index.js";
import { parseMultipartUploads } from "../src/xml.js";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/transport.js";
import type { S3Config } from "../src/config.js";

const BASE: Omit<S3Config, "transport"> = {
  endpoint: "http://s3.internal:9000",
  bucket: "vault",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "VERY-SECRET",
  conditionalWrites: false,
  retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 },
};

const xml = (status: number, body: string): HttpResponse => ({
  status,
  headers: { "content-type": "application/xml" },
  body: new TextEncoder().encode(body),
});

const isUploadsList = (r: HttpRequest): boolean =>
  r.method === "GET" && r.url.includes("uploads=");

describe("the endpoint path is part of the endpoint", () => {
  it("A PATH PREFIX SURVIVES INTO EVERY REQUEST", async () => {
    // MinIO or Ceph behind a reverse proxy on a path — the deployment
    // RFC-0006 names as a target. `URL.origin` dropped it silently, so every
    // request went to the wrong place and nothing said the path had been
    // discarded.
    const seen: string[] = [];
    const transport: HttpTransport = (req) => {
      seen.push(new URL(req.url).pathname);
      return Promise.resolve({ status: 200, headers: { etag: '"e"' }, body: new Uint8Array() });
    };
    const storage = await S3Storage.create({
      ...BASE,
      endpoint: "https://gateway.example.com/s3",
      forcePathStyle: true,
      transport,
    });

    await storage.put("objects/aa/one", new TextEncoder().encode("x"));
    expect(seen).toEqual(["/s3/vault/objects/aa/one"]);
  });

  it("a trailing slash does not double up, and no path still works", () => {
    const url = (endpoint: string): string =>
      new S3Client({ ...BASE, endpoint, forcePathStyle: true }).urlFor("objects/k");
    expect(url("https://gateway.example.com/s3/")).toBe(
      "https://gateway.example.com/s3/vault/objects/k",
    );
    expect(url("https://gateway.example.com")).toBe(
      "https://gateway.example.com/vault/objects/k",
    );
  });

  it("virtual-host style keeps the path in front of the key", () => {
    const client = new S3Client({
      ...BASE,
      endpoint: "https://gateway.example.com/s3",
      forcePathStyle: false,
    });
    expect(client.urlFor("objects/k")).toBe(
      "https://vault.gateway.example.com/s3/objects/k",
    );
  });
});

describe("the one request that is not idempotent", () => {
  /**
   * A backend that CARRIES OUT the initiate and then fails to answer — a
   * dropped socket, a proxy answering 503 after the bucket already created
   * the upload. The retry gets a second upload; the first is orphaned, its
   * parts are billed, and no object listing shows it.
   */
  function lossyInitiate(): { transport: HttpTransport; created: string[]; aborted: string[] } {
    const created: string[] = [];
    const aborted: string[] = [];
    let initiates = 0;
    const transport: HttpTransport = (req) => {
      if (req.method === "POST" && req.url.includes("uploads=")) {
        initiates++;
        created.push(`upload-${String(initiates)}`);
        // The first one is created server-side and the answer is lost.
        return initiates === 1
          ? Promise.resolve(xml(503, "<Error><Code>InternalError</Code></Error>"))
          : Promise.resolve(
              xml(
                200,
                `<InitiateMultipartUploadResult><UploadId>upload-${String(initiates)}</UploadId></InitiateMultipartUploadResult>`,
              ),
            );
      }
      if (isUploadsList(req)) {
        const open = created.filter((id) => !aborted.includes(id));
        return Promise.resolve(
          xml(
            200,
            `<ListMultipartUploadsResult>${open
              .map((id) => `<Upload><Key>objects%2Fbig</Key><UploadId>${id}</UploadId></Upload>`)
              .join("")}</ListMultipartUploadsResult>`,
          ),
        );
      }
      if (req.method === "DELETE") {
        const id = new URL(req.url).searchParams.get("uploadId");
        if (id !== null) aborted.push(id);
        return Promise.resolve({ status: 204, headers: {}, body: new Uint8Array() });
      }
      if (req.method === "PUT") {
        return Promise.resolve({ status: 200, headers: { etag: '"part"' }, body: new Uint8Array() });
      }
      // CompleteMultipartUpload
      return Promise.resolve(xml(200, "<CompleteMultipartUploadResult><ETag>&quot;done&quot;</ETag></CompleteMultipartUploadResult>"));
    };
    return { transport, created, aborted };
  }

  const big = (): Uint8Array => new Uint8Array(12 * 1024 * 1024);

  it("THE UPLOAD A LOST ANSWER CREATED IS ABORTED, NOT LEFT TO BILL", async () => {
    const { transport, created, aborted } = lossyInitiate();
    const storage = await S3Storage.create({
      ...BASE,
      multipartThresholdBytes: 5 * 1024 * 1024,
      partSizeBytes: 5 * 1024 * 1024,
      transport,
    });

    const res = await storage.put("objects/big", big());
    expect(res.etag).toBe('"done"');

    // Two were created; the one we never learned the id of is gone, and the
    // one we completed was not touched.
    expect(created).toEqual(["upload-1", "upload-2"]);
    expect(aborted).toEqual(["upload-1"]);
  });

  it("an upload that needed no retry costs no extra request", async () => {
    const seen: string[] = [];
    const transport: HttpTransport = (req) => {
      seen.push(`${req.method} ${new URL(req.url).search}`);
      if (req.method === "POST" && req.url.includes("uploads=")) {
        return Promise.resolve(
          xml(200, "<InitiateMultipartUploadResult><UploadId>only</UploadId></InitiateMultipartUploadResult>"),
        );
      }
      if (req.method === "PUT") {
        return Promise.resolve({ status: 200, headers: { etag: '"part"' }, body: new Uint8Array() });
      }
      return Promise.resolve(xml(200, "<CompleteMultipartUploadResult><ETag>&quot;done&quot;</ETag></CompleteMultipartUploadResult>"));
    };
    const storage = await S3Storage.create({
      ...BASE,
      multipartThresholdBytes: 5 * 1024 * 1024,
      partSizeBytes: 5 * 1024 * 1024,
      transport,
    });

    await storage.put("objects/big", big());

    // No ListMultipartUploads, no DELETE: the ordinary path is unchanged.
    expect(seen.filter((s) => s.includes("uploads=") && s.startsWith("GET"))).toEqual([]);
    expect(seen.filter((s) => s.startsWith("DELETE"))).toEqual([]);
  });

  it("A FAILED UPLOAD STILL ABORTS ITS OWN, AND THE FAILURE SURFACES", async () => {
    const aborted: string[] = [];
    const transport: HttpTransport = (req) => {
      if (req.method === "POST" && req.url.includes("uploads=")) {
        return Promise.resolve(
          xml(200, "<InitiateMultipartUploadResult><UploadId>mine</UploadId></InitiateMultipartUploadResult>"),
        );
      }
      if (req.method === "DELETE") {
        const id = new URL(req.url).searchParams.get("uploadId");
        if (id !== null) aborted.push(id);
        return Promise.resolve({ status: 204, headers: {}, body: new Uint8Array() });
      }
      // Every part fails definitively.
      return Promise.resolve(xml(403, "<Error><Code>AccessDenied</Code></Error>"));
    };
    const storage = await S3Storage.create({
      ...BASE,
      multipartThresholdBytes: 5 * 1024 * 1024,
      partSizeBytes: 5 * 1024 * 1024,
      transport,
    });

    await expect(storage.put("objects/big", big())).rejects.toSatisfy((e) =>
      isSyncError(e, "StorageUnauthorized"),
    );
    expect(aborted).toEqual(["mine"]);
  });

  it("the listing is read as carefully as any other answer", () => {
    const body = `<ListMultipartUploadsResult>
      <Upload><Key>objects%2Fbig</Key><UploadId>ours</UploadId></Upload>
      <Upload><Key>objects%2Fbig-other</Key><UploadId>someone-elses</UploadId></Upload>
      <Upload><Key>objects%2F%zz</Key><UploadId>undecodable</UploadId></Upload>
      <Upload><Key>objects%2Fbig</Key><UploadId></UploadId></Upload>
      <Upload><Key>objects%2Fbig</Key></Upload>
    </ListMultipartUploadsResult>`;
    // A prefix match is not an exact one: "objects/big-other" starts with
    // "objects/big", and aborting that upload would destroy a different
    // object's progress.
    expect(parseMultipartUploads(body, "objects/big")).toEqual(["ours"]);
    expect(parseMultipartUploads("<ListMultipartUploadsResult/>", "objects/big")).toEqual([]);
  });
});
