// ADR-0052. The S3 backend chooses every byte of every response, and this
// provider believed all of it — the same four ways ADR-0039 had already found
// and closed in WebDAV.
//
// A key out of a listing became a URL, `..` and all. A prefix with a space was
// signed one way and sent another. "There is more" with no continuation token
// ended the listing as if it were complete. A garbled Size became NaN, and a
// malformed percent-escape threw URIError straight past the error taxonomy.

import { describe, expect, it } from "vitest";

import { isSyncError, SyncError } from "@syncrypt/core";

import { S3Client } from "../src/client.js";
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

const xml = (body: string): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/xml" },
  body: new TextEncoder().encode(body),
});

const listing = (rows: string, extra = ""): string =>
  `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${extra}${rows}</ListBucketResult>`;

const contents = (key: string, size = "7"): string =>
  `<Contents><Key>${key}</Key><Size>${size}</Size>` +
  `<LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;e&quot;</ETag></Contents>`;

/** Records what actually went on the wire. */
function recording(body: string): { transport: HttpTransport; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    transport: (req: HttpRequest) => {
      urls.push(req.url);
      return Promise.resolve(xml(body));
    },
  };
}

const storage = (transport: HttpTransport): Promise<S3Storage> =>
  S3Storage.create({ ...BASE, transport });

// ---------------------------------------------------------------------------
describe("a vault prefix that needs percent-encoding", () => {
  // What SigV4 canonicalizes with, and what S3 matches a prefix against.
  const rfc3986 = (s: string): string =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );

  const cases: [string, string][] = [
    ["a space", "Мои заметки/manifests/"],
    ["a tilde", "vault~1/manifests/"],
    ["an asterisk", "vault*x/manifests/"],
    ["cyrillic only", "Заметки/manifests/"],
    ["a plus", "a+b/manifests/"],
    ["an ampersand", "a&b/manifests/"],
    ["an equals sign", "a=b/manifests/"],
  ];

  for (const [name, prefix] of cases) {
    it(`goes on the wire exactly as it is signed: ${name}`, async () => {
      const { transport, urls } = recording(listing(""));
      const s = await storage(transport);
      for await (const _ of s.list(prefix)) break;

      const sent = /[?&]prefix=([^&]*)/.exec(urls[0] ?? "")?.[1] ?? "";
      // Not "+"-for-space, not %7E for "~": the signer canonicalizes the
      // DECODED query per RFC 3986, so anything else is signed as one string
      // and sent as another — 403 on a backend that checks, and a prefix that
      // matches nothing on one that does not.
      expect(sent, name).toBe(rfc3986(prefix));
      expect(decodeURIComponent(sent), name).toBe(prefix);
    });
  }

  it("a listing under such a prefix comes back whole", async () => {
    const prefix = "Мои заметки/manifests/";
    const key = `${prefix}000000001-devA.json`;
    const { transport } = recording(listing(contents(encodeURIComponent(key).replaceAll("%2F", "/"))));
    const s = await storage(transport);
    const keys: string[] = [];
    for await (const stat of s.list(prefix)) keys.push(stat.key);
    expect(keys).toEqual([key]);
  });
});

// ---------------------------------------------------------------------------
describe("a key the server chose is not a path we will build", () => {
  it("urlFor refuses `..`, `.` and empty segments", () => {
    const c = new S3Client({
      endpoint: "https://acc.r2.cloudflarestorage.com",
      bucket: "vault",
      accessKeyId: "a",
      secretAccessKey: "b",
    });
    for (const bad of [
      "objects/../manifests/000000009-devA.json",
      "vaults/main/objects/../../../manifests/000000009-devA.json",
      "objects/./aa",
      "objects//aa",
    ]) {
      expect(() => c.urlFor(bad), bad).toThrow(/refusing unsafe key/);
    }
    // The bucket-level request (key "") is not a key and stays allowed.
    expect(c.urlFor("", { "list-type": "2" })).toContain("?list-type=2");
  });

  it("delete() of a traversing key never leaves objects/", async () => {
    const attempted: string[] = [];
    const s = await storage((req: HttpRequest) => {
      attempted.push(req.url);
      return Promise.resolve({ status: 204, headers: {}, body: new Uint8Array() });
    });
    await expect(
      s.delete("vaults/main/objects/../../../manifests/000000009-devA.json"),
    ).rejects.toSatisfy((e) => isSyncError(e, "StorageTransient"));
    expect(attempted).toEqual([]); // nothing was dispatched at all
  });

  it("a listing that answers about another prefix is ignored", async () => {
    const { transport } = recording(
      listing(contents("objects/aa/bb/mine") + contents("manifests/000000009-devA.json")),
    );
    const s = await storage(transport);
    const keys: string[] = [];
    for await (const stat of s.list("objects/")) keys.push(stat.key);
    expect(keys).toEqual(["objects/aa/bb/mine"]);
  });
});

// ---------------------------------------------------------------------------
describe("paging is the server's answer, so all three lies are refused", () => {
  it("truncated with no continuation token is an error, not the end of the list", async () => {
    let calls = 0;
    const s = await storage(() => {
      calls++;
      return Promise.resolve(
        xml(
          `<ListBucketResult><IsTruncated>true</IsTruncated>${contents("manifests/000000001-devA.json")}</ListBucketResult>`,
        ),
      );
    });
    const keys: string[] = [];
    await expect(
      (async () => {
        for await (const stat of s.list("manifests/")) keys.push(stat.key);
      })(),
    ).rejects.toSatisfy((e) => isSyncError(e, "StorageTransient"));
    expect(calls).toBe(1);
    // Reporting a partial listing as complete is what makes this dangerous:
    // a lower generation on manifests/, half the retained set when reclaiming.
    expect(keys).toEqual(["manifests/000000001-devA.json"]);
  });

  it("an empty continuation token is the same lie", async () => {
    const s = await storage(() =>
      Promise.resolve(
        xml(
          `<ListBucketResult><IsTruncated>true</IsTruncated>` +
            `<NextContinuationToken></NextContinuationToken></ListBucketResult>`,
        ),
      ),
    );
    await expect(
      (async () => {
        for await (const _ of s.list("manifests/")) break;
      })(),
    ).rejects.toSatisfy((e) => isSyncError(e, "StorageTransient"));
  });

  it("a repeated continuation token stops instead of looping for ever", async () => {
    let calls = 0;
    const s = await storage(() => {
      calls++;
      return Promise.resolve(
        xml(
          `<ListBucketResult><IsTruncated>true</IsTruncated>` +
            `<NextContinuationToken>tok</NextContinuationToken></ListBucketResult>`,
        ),
      );
    });
    const outcome = await Promise.race([
      (async () => {
        for await (const _ of s.list("manifests/")) break;
        return "finished";
      })().catch((e: unknown) => (isSyncError(e, "StorageTransient") ? "refused" : "other")),
      new Promise((r) => {
        setTimeout(() => {
          r("still spinning");
        }, 1500);
      }),
    ]);
    // The pages are empty, so the generator never yields and the abort checks
    // in readRemote and listObjects never get control: this used to be an
    // uncancellable sync burning requests.
    expect(outcome).toBe("refused");
    expect(calls).toBe(2);
  }, 20_000);

  it("honest paging still works", async () => {
    const pages = [
      `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken>${contents("objects/a")}</ListBucketResult>`,
      `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken>${contents("objects/b")}</ListBucketResult>`,
      `<ListBucketResult><IsTruncated>false</IsTruncated>${contents("objects/c")}</ListBucketResult>`,
    ];
    let n = 0;
    const s = await storage(() => Promise.resolve(xml(pages[n++] ?? "")));
    const keys: string[] = [];
    for await (const stat of s.list("objects/")) keys.push(stat.key);
    expect(keys).toEqual(["objects/a", "objects/b", "objects/c"]);
  });
});

// ---------------------------------------------------------------------------
describe("numbers and keys out of a hostile listing", () => {
  it("a garbled Size is 0, never NaN", () => {
    for (const raw of ["9e99999x", "", "NaN", "Infinity", "-", "1e400"]) {
      const page = parseListObjectsV2(listing(contents("objects/aa/bb/cc", raw)));
      const size = page.contents[0]?.size ?? NaN;
      expect(Number.isFinite(size), raw).toBe(true);
    }
  });

  it("an unparsable LastModified is 0, never NaN", () => {
    const page = parseListObjectsV2(
      listing(
        `<Contents><Key>objects/aa/bb/cc</Key><Size>7</Size>` +
          `<LastModified>never</LastModified><ETag>&quot;e&quot;</ETag></Contents>`,
      ),
    );
    expect(Number.isFinite(page.contents[0]?.lastModified ?? NaN)).toBe(true);
  });

  it("a real size and date still parse", () => {
    const page = parseListObjectsV2(listing(contents("objects/aa/bb/cc", "4096")));
    expect(page.contents[0]?.size).toBe(4096);
    expect(page.contents[0]?.lastModified).toBe(Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000));
  });

  it("a malformed percent-escape drops the row instead of throwing URIError", async () => {
    const { transport } = recording(listing(contents("objects/%zz") + contents("objects/good")));
    const s = await storage(transport);
    const keys: string[] = [];
    for await (const stat of s.list("objects/")) keys.push(stat.key);
    // Not a URIError out of the middle of a listing, and not a listing that
    // dies because one row was garbage: an object missing from a listing is
    // never a deletion candidate.
    expect(keys).toEqual(["objects/good"]);
  });

  it("the whole taxonomy still holds when a listing fails outright", async () => {
    const s = await storage(() =>
      Promise.resolve({
        status: 503,
        headers: {},
        body: new TextEncoder().encode("<Error><Code>SlowDown</Code></Error>"),
      }),
    );
    await expect(
      (async () => {
        for await (const _ of s.list("objects/")) break;
      })(),
    ).rejects.toSatisfy((e) => e instanceof SyncError && e.code === "StorageRateLimited");
  });
});
