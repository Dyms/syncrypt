// Unit tests over a mocked transport: multistatus parsing (namespace and
// encoding variants), MKCOL-on-409, etag fallback, auth handling, error
// normalization, list prefix semantics. Live-server behavior is covered by
// conformance.test.ts.

import { describe, expect, it } from "vitest";

import { isSyncError, type HttpRequest, type HttpResponse, type HttpTransport } from "@syncrypt/core";

import { parseMultistatus, WebDavStorage, type WebDavConfig } from "../src/index.js";

const BASE: Omit<WebDavConfig, "transport"> = {
  baseUrl: "http://dav.internal/remote.php/dav/files/user/vault/",
  username: "davuser",
  password: "very-secret-password",
  retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
};

function respond(status: number, headers: Record<string, string> = {}, body = ""): HttpResponse {
  return { status, headers, body: new TextEncoder().encode(body) };
}

describe("multistatus parsing", () => {
  it("is namespace-agnostic and decodes hrefs (encoded, unicode, full URL)", () => {
    const xml = `<?xml version="1.0"?>
      <D:multistatus xmlns:D="DAV:">
        <D:response>
          <D:href>/remote.php/dav/files/user/vault/dir%20a/note%20one.md</D:href>
          <D:propstat><D:prop>
            <D:resourcetype/><D:getcontentlength>42</D:getcontentlength>
            <D:getetag>&quot;abc-1&quot;</D:getetag>
            <D:getlastmodified>Thu, 17 Jul 2026 12:00:00 GMT</D:getlastmodified>
          </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
        </D:response>
        <d:response xmlns:d="DAV:">
          <d:href>http://dav.internal/remote.php/dav/files/user/vault/%D1%80%D0%B5%D0%B7.md</d:href>
          <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>7</d:getcontentlength>
          <d:getetag>"xyz"</d:getetag></d:prop></d:propstat>
        </d:response>
        <response xmlns="DAV:">
          <href>/remote.php/dav/files/user/vault/sub/</href>
          <propstat><prop><resourcetype><collection/></resourcetype></prop></propstat>
        </response>
      </D:multistatus>`;
    const entries = parseMultistatus(xml);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      path: "/remote.php/dav/files/user/vault/dir a/note one.md",
      isCollection: false,
      size: 42,
      etag: '"abc-1"',
      lastModified: Math.floor(Date.parse("2026-07-17T12:00:00Z") / 1000),
    });
    expect(entries[1]?.path).toBe("/remote.php/dav/files/user/vault/рез.md");
    expect(entries[2]).toMatchObject({
      path: "/remote.php/dav/files/user/vault/sub",
      isCollection: true,
    });
  });
});

describe("put", () => {
  it("creates missing parent collections on 409 and retries once", async () => {
    const log: string[] = [];
    const transport: HttpTransport = (req) => {
      const path = new URL(req.url).pathname;
      log.push(`${req.method} ${path}`);
      if (req.method === "PUT" && log.filter((l) => l.startsWith("PUT")).length === 1) {
        return Promise.resolve(respond(409));
      }
      if (req.method === "MKCOL") {
        // first level already exists → 405; deeper levels → 201
        return Promise.resolve(respond(path.endsWith("/objects") ? 405 : 201));
      }
      return Promise.resolve(respond(201, { etag: '"e1"' }));
    };
    const storage = new WebDavStorage({ ...BASE, transport });
    const result = await storage.put("objects/ab/cd/key", new Uint8Array([1]));
    expect(result.etag).toBe('"e1"');
    expect(log).toEqual([
      "PUT /remote.php/dav/files/user/vault/objects/ab/cd/key",
      "MKCOL /remote.php/dav/files/user/vault/objects",
      "MKCOL /remote.php/dav/files/user/vault/objects/ab",
      "MKCOL /remote.php/dav/files/user/vault/objects/ab/cd",
      "PUT /remote.php/dav/files/user/vault/objects/ab/cd/key",
    ]);
  });

  it("falls back to PROPFIND for the etag when PUT omits the header", async () => {
    const transport: HttpTransport = (req) => {
      if (req.method === "PUT") return Promise.resolve(respond(204)); // no etag header
      if (req.method === "PROPFIND") {
        return Promise.resolve(
          respond(
            207,
            {},
            `<D:multistatus xmlns:D="DAV:"><D:response>
               <D:href>/remote.php/dav/files/user/vault/k</D:href>
               <D:propstat><D:prop><D:resourcetype/>
                 <D:getcontentlength>1</D:getcontentlength>
                 <D:getetag>"from-propfind"</D:getetag>
               </D:prop></D:propstat></D:response></D:multistatus>`,
          ),
        );
      }
      return Promise.resolve(respond(500));
    };
    const storage = new WebDavStorage({ ...BASE, transport });
    expect((await storage.put("k", new Uint8Array([1]))).etag).toBe('"from-propfind"');
  });
});

describe("auth and errors", () => {
  it("sends Basic auth; errors carry status+key but never the password", async () => {
    let sawAuth = "";
    const transport: HttpTransport = (req) => {
      sawAuth = req.headers.authorization ?? "";
      return Promise.resolve(respond(403));
    };
    const storage = new WebDavStorage({ ...BASE, transport });
    try {
      await storage.get("secret/key");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(sawAuth).toBe(`Basic ${btoa("davuser:very-secret-password")}`);
      expect(isSyncError(e, "StorageUnauthorized"), String(e)).toBe(true);
      const text = `${(e as Error).message} ${(e as Error).stack ?? ""}`;
      expect(text).toContain("secret/key");
      expect(text).not.toContain("very-secret-password");
      expect(text).not.toContain(btoa("davuser:very-secret-password"));
    }
  });

  it("supports Bearer auth", async () => {
    let sawAuth = "";
    const transport: HttpTransport = (req) => {
      sawAuth = req.headers.authorization ?? "";
      return Promise.resolve(respond(200));
    };
    const storage = new WebDavStorage({
      baseUrl: BASE.baseUrl,
      bearerToken: "tok-123",
      transport,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await storage.get("k");
    expect(sawAuth).toBe("Bearer tok-123");
  });

  it("delete treats 404 as success; stat maps 404 to StorageNotFound", async () => {
    const transport: HttpTransport = () => Promise.resolve(respond(404));
    const storage = new WebDavStorage({ ...BASE, transport });
    await expect(storage.delete("gone")).resolves.toBeUndefined();
    await expect(storage.stat("gone")).rejects.toSatisfy((e) =>
      isSyncError(e, "StorageNotFound"),
    );
  });

  it("stat of a collection reports StorageNotFound (not an object)", async () => {
    const transport: HttpTransport = () =>
      Promise.resolve(
        respond(
          207,
          {},
          `<D:multistatus xmlns:D="DAV:"><D:response>
             <D:href>/remote.php/dav/files/user/vault/dir/</D:href>
             <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype>
             </D:prop></D:propstat></D:response></D:multistatus>`,
        ),
      );
    const storage = new WebDavStorage({ ...BASE, transport });
    await expect(storage.stat("dir")).rejects.toSatisfy((e) =>
      isSyncError(e, "StorageNotFound"),
    );
  });
});

describe("list prefix semantics (S3-style, not folder-bound)", () => {
  function davServerMock(): HttpTransport {
    // Tree: a/1, a/2, a/sub/3, ab.md, b/4
    const collections: Record<string, { files: [string, number][]; dirs: string[] }> = {
      "": { files: [["ab.md", 5]], dirs: ["a", "b"] },
      a: { files: [["a/1", 1], ["a/2", 2]], dirs: ["a/sub"] },
      "a/sub": { files: [["a/sub/3", 3]], dirs: [] },
      b: { files: [["b/4", 4]], dirs: [] },
    };
    const basePath = "/remote.php/dav/files/user/vault";
    return (req: HttpRequest) => {
      const key = decodeURIComponent(new URL(req.url).pathname)
        .slice(basePath.length)
        .replace(/^\/+|\/+$/g, "");
      const col = collections[key];
      if (col === undefined) return Promise.resolve(respond(404));
      const self = `<D:response><D:href>${basePath}/${key}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`;
      const rows = [
        ...col.dirs.map(
          (d) =>
            `<D:response><D:href>${basePath}/${d}/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`,
        ),
        ...col.files.map(
          ([f, size]) =>
            `<D:response><D:href>${basePath}/${f}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>${size}</D:getcontentlength><D:getetag>"e${size}"</D:getetag></D:prop></D:propstat></D:response>`,
        ),
      ].join("");
      return Promise.resolve(
        respond(207, {}, `<D:multistatus xmlns:D="DAV:">${self}${rows}</D:multistatus>`),
      );
    };
  }

  async function keys(storage: WebDavStorage, prefix: string): Promise<string[]> {
    const out: string[] = [];
    for await (const stat of storage.list(prefix)) out.push(stat.key);
    return out;
  }

  it("folder prefix, string prefix, empty prefix, and missing prefix", async () => {
    const storage = new WebDavStorage({ ...BASE, transport: davServerMock() });
    expect(await keys(storage, "a/")).toEqual(["a/1", "a/2", "a/sub/3"]);
    expect(await keys(storage, "a")).toEqual(["a/1", "a/2", "a/sub/3", "ab.md"]);
    expect(await keys(storage, "")).toEqual(["a/1", "a/2", "a/sub/3", "ab.md", "b/4"]);
    expect(await keys(storage, "nope/")).toEqual([]);
  });
});
