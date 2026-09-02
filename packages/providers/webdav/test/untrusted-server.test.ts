// ADR-0039. The WebDAV server chooses every byte of every response.
//
// This provider used to believe all of it: an href outside our collection
// became a key, `..` segments passed through into a DELETE url, a row the
// server marked 404 came back as a perfectly good object, and a base URL that
// needed percent-encoding matched no href at all — silently, because the
// base was compared encoded against hrefs that had been decoded.

import { describe, expect, it } from "vitest";

import type { HttpTransport } from "@syncrypt/core";

import { WebDavClient } from "../src/client.js";
import { WebDavStorage } from "../src/storage.js";
import { parseMultistatus } from "../src/xml.js";
import { startLocalDav, randomPrefixKeyed } from "./live-server.js";

const multistatus = (rows: string): string =>
  `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${rows}</D:multistatus>`;

const xmlTransport = (body: string): HttpTransport => () =>
  Promise.resolve({
    status: 207,
    headers: { "content-type": "application/xml" },
    body: new TextEncoder().encode(body),
  });

const row = (href: string, props: string, status = "HTTP/1.1 200 OK"): string =>
  `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop>` +
  `<D:status>${status}</D:status></D:propstat></D:response>`;

const FILE_PROPS = '<D:resourcetype/><D:getcontentlength>7</D:getcontentlength><D:getetag>"e"</D:getetag>';

describe("a base URL whose path needs percent-encoding", () => {
  const cases: [string, string, string][] = [
    ["a space", "/remote.php/dav/files/user/My Vault", "/remote.php/dav/files/user/My%20Vault"],
    ["cyrillic", "/dav/Заметки", "/dav/%D0%97%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B8"],
    ["an ampersand", "/dav/notes & things", "/dav/notes%20&%20things"],
  ];

  for (const [name, decoded, hrefPath] of cases) {
    it(`still resolves keys: ${name}`, () => {
      const c = new WebDavClient({ baseUrl: `https://cloud.example.com${decoded}` });
      const entry = parseMultistatus(
        multistatus(row(`${hrefPath}/manifests/000000001-devA.json`, FILE_PROPS)),
      )[0];
      expect(c.keyFor(entry?.path ?? "")).toBe("manifests/000000001-devA.json");
    });
  }

  it("end to end against a real server, in a folder with a space", async () => {
    // The whole point: list() is the ADR-0006 safety mechanism. A silent empty
    // list is a vault where no device ever sees another device's generation.
    const dav = await startLocalDav();
    try {
      const outer = randomPrefixKeyed(dav.config);
      await new WebDavClient(outer).sendOk({ method: "MKCOL", key: "", operation: "mkcol" });
      const base = { ...outer, baseUrl: `${outer.baseUrl}/My Notes 2026` };
      await new WebDavClient(base).sendOk({ method: "MKCOL", key: "", operation: "mkcol" });
      const storage = new WebDavStorage(base);
      await storage.put("manifests/000000001-devA.json", new TextEncoder().encode("{}"));
      await storage.put("objects/ab/cd/ef", new TextEncoder().encode("ciphertext"));

      const listed: string[] = [];
      for await (const stat of storage.list("manifests/")) listed.push(stat.key);
      expect(listed).toEqual(["manifests/000000001-devA.json"]);

      const objects: string[] = [];
      for await (const stat of storage.list("objects/")) objects.push(stat.key);
      expect(objects).toEqual(["objects/ab/cd/ef"]);
    } finally {
      await dav.stop();
    }
  }, 30_000);
});

describe("an href the server chose", () => {
  it("outside our collection is not a key", () => {
    const c = new WebDavClient({ baseUrl: "https://h/dav/vault" });
    expect(c.keyFor("/dav/somebody-elses-vault/objects/aa")).toBeNull();
    expect(c.keyFor("/etc/passwd")).toBeNull();
    // …and the one inside it still is.
    expect(c.keyFor("/dav/vault/objects/aa")).toBe("objects/aa");
    expect(c.keyFor("/dav/vault")).toBe("");
  });

  it("with .. segments is not a key, and never becomes a URL", () => {
    const c = new WebDavClient({ baseUrl: "https://h/dav/vault" });
    expect(c.keyFor("/dav/vault/manifests/000000001-../../../../Documents/Taxes.json")).toBeNull();
    expect(c.keyFor("/dav/vault/objects/./aa")).toBeNull();
    expect(c.keyFor("/dav/vault/objects//aa")).toBeNull();
    expect(() => c.urlFor("manifests/../../Documents/Taxes.json")).toThrow(/unsafe key/);
  });

  it("is dropped from list() rather than turned into a deletable object", async () => {
    const body = multistatus(
      row("/dav/vault/objects/", "<D:resourcetype><D:collection/></D:resourcetype>") +
        row("/dav/vault/objects/mine", FILE_PROPS) +
        row("/somewhere/else/theirs", FILE_PROPS) +
        row("/dav/vault/objects/../../escape", FILE_PROPS),
    );
    const s = new WebDavStorage({ baseUrl: "http://h/dav/vault", transport: xmlTransport(body) });
    const keys: string[] = [];
    for await (const stat of s.list("objects/")) keys.push(stat.key);
    expect(keys).toEqual(["objects/mine"]);
  });
});

describe("a row the server marked as an error", () => {
  const NOT_FOUND = multistatus(
    row("/dav/vault/objects/ab/cd/ef", "<D:resourcetype/><D:getcontentlength/><D:getetag/>",
      "HTTP/1.1 404 Not Found"),
  );

  it("does not satisfy stat() — the dedup probe must not skip that upload", async () => {
    const s = new WebDavStorage({ baseUrl: "http://h/dav/vault", transport: xmlTransport(NOT_FOUND) });
    await expect(s.stat("objects/ab/cd/ef")).rejects.toThrow(/not a file|not found/i);
  });

  it("is not listed as an object either", async () => {
    const s = new WebDavStorage({ baseUrl: "http://h/dav/vault", transport: xmlTransport(NOT_FOUND) });
    const keys: string[] = [];
    for await (const stat of s.list("objects/")) keys.push(stat.key);
    expect(keys).toEqual([]);
  });

  it("a response-level status is honoured too, not only a propstat one", async () => {
    const body = multistatus(
      `<D:response><D:href>/dav/vault/objects/gone</D:href>` +
        `<D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
    );
    const s = new WebDavStorage({ baseUrl: "http://h/dav/vault", transport: xmlTransport(body) });
    await expect(s.stat("objects/gone")).rejects.toThrow();
  });
});

describe("stat() answers about the key it was asked for", () => {
  it("a row for a different resource is not an answer", async () => {
    const body = multistatus(row("/dav/vault/objects/SOMETHING/ELSE", FILE_PROPS));
    const s = new WebDavStorage({ baseUrl: "http://h/dav/vault", transport: xmlTransport(body) });
    await expect(s.stat("objects/ab/cd/ef")).rejects.toThrow(/not a file/);
  });

  it("the right row among several is used", async () => {
    const body = multistatus(
      row("/dav/vault/objects/other", '<D:resourcetype/><D:getcontentlength>1</D:getcontentlength><D:getetag>"x"</D:getetag>') +
        row("/dav/vault/objects/wanted", '<D:resourcetype/><D:getcontentlength>42</D:getcontentlength><D:getetag>"y"</D:getetag>'),
    );
    const s = new WebDavStorage({ baseUrl: "http://h/dav/vault", transport: xmlTransport(body) });
    expect(await s.stat("objects/wanted")).toMatchObject({ size: 42, etag: '"y"' });
  });
});

describe("a collection is never an object", () => {
  it("recognised by its trailing slash even when no property survives", async () => {
    // DELETE on a collection removes the whole subtree (RFC 4918 §9.6). A
    // collection that reaches the reclaim sweep as a zero-byte object takes
    // every live object under it with it.
    const body = multistatus(
      row("/dav/vault/objects/", "<D:resourcetype><D:collection/></D:resourcetype>") +
        row("/dav/vault/objects/ab/", "<D:resourcetype/><D:getcontentlength/>", "HTTP/1.1 404 Not Found"),
    );
    const s = new WebDavStorage({ baseUrl: "http://h/dav/vault", transport: xmlTransport(body) });
    const keys: string[] = [];
    for await (const stat of s.list("objects/")) keys.push(stat.key);
    expect(keys).toEqual([]);
  });

  it("recognised by its trailing slash when resourcetype came back empty", async () => {
    // The row IS described — a 2xx propstat — it just does not say
    // <collection>. The trailing slash is then the only signal there is, and
    // without it this collection becomes a zero-byte sweep candidate.
    const body = multistatus(
      row("/dav/vault/objects/", "<D:resourcetype><D:collection/></D:resourcetype>") +
        row("/dav/vault/objects/ab/", "<D:resourcetype/><D:getcontentlength>0</D:getcontentlength>"),
    );
    const s = new WebDavStorage({ baseUrl: "http://h/dav/vault", transport: xmlTransport(body) });
    const keys: string[] = [];
    for await (const stat of s.list("objects/")) keys.push(stat.key);
    expect(keys).toEqual([]);
  });

  it("recognised through a namespaced or attributed <collection>", () => {
    const variants = [
      "<D:collection/>",
      "<collection xmlns=\"DAV:\"/>",
      "<lp1:collection/>",
      "<ns0:collection />",
      "<D:collection></D:collection>",
    ];
    for (const v of variants) {
      const entry = parseMultistatus(
        multistatus(row("/dav/vault/objects/ab", `<D:resourcetype>${v}</D:resourcetype>`)),
      )[0];
      expect(entry?.isCollection, v).toBe(true);
    }
  });
});

describe("numbers a hostile server sends", () => {
  it("never come out as NaN", () => {
    const entry = parseMultistatus(
      multistatus(
        row("/dav/vault/objects/x",
          "<D:resourcetype/><D:getcontentlength>12,345</D:getcontentlength>" +
          "<D:getlastmodified>whenever</D:getlastmodified>"),
      ),
    )[0];
    expect(entry?.size).toBe(0);
    expect(entry?.lastModified).toBe(0);
  });
});
