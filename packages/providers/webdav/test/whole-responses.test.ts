// A PROPFIND answered 200 with a proxy page is an EMPTY listing, and a 207 cut
// off mid-stream is a SHORTER one. Neither may be read as "that is what is
// there": the engine decides which generations exist from this list.

import { describe, expect, it } from "vitest";

import { isSyncError, type HttpTransport } from "@syncrypt/core";

import { WebDavStorage } from "../src/storage.js";
import { isWholeMultistatus } from "../src/xml.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dav =
  (body: string, status = 207): HttpTransport =>
  () =>
    Promise.resolve({ status, headers: {}, body: enc(body) });
const entry = (n: number): string =>
  `<D:response><D:href>/dav/manifests/00000000${String(n)}-a.json</D:href><D:propstat><D:prop><D:getcontentlength>7</D:getcontentlength><D:getetag>"e"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const multistatus = (inner: string): string => `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${inner}</D:multistatus>`;

async function keys(it: AsyncIterable<{ key: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of it) out.push(s.key);
  return out;
}

describe("WebDAV list is believed only as a whole multistatus document", () => {
  const storage = (body: string, status = 207): WebDavStorage =>
    new WebDavStorage({ baseUrl: "http://h/dav", transport: dav(body, status) });

  it("a proxy page answered 200 is not an empty listing", async () => {
    await expect(keys(storage("<html>captive portal</html>", 200).list("manifests/"))).rejects.toSatisfy(
      (e: unknown) => isSyncError(e, "StorageTransient"),
    );
  });

  it("a 207 cut in the middle does not become a shorter listing", async () => {
    const cut = `<D:multistatus xmlns:D="DAV:">${entry(1)}${entry(2)}<D:response><D:href>/dav/manifests/00000`;
    await expect(keys(storage(cut).list("manifests/")).then((k) => k)).rejects.toSatisfy((e: unknown) =>
      isSyncError(e, "StorageTransient"),
    );
  });

  it("a whole document lists, with any namespace prefix", async () => {
    const s = storage(multistatus(entry(1) + entry(2)));
    expect((await keys(s.list("manifests/"))).length).toBe(2);
  });

  it("recognises whole documents and refuses the rest", () => {
    expect(isWholeMultistatus(multistatus(""))).toBe(true);
    expect(isWholeMultistatus(`<multistatus xmlns="DAV:"></multistatus>\n`)).toBe(true);
    expect(isWholeMultistatus(`<D:multistatus xmlns:D="DAV:"/>`)).toBe(true);
    expect(isWholeMultistatus("<html></html>")).toBe(false);
    expect(isWholeMultistatus("")).toBe(false);
    expect(isWholeMultistatus(`<D:multistatus xmlns:D="DAV:">${entry(1)}`)).toBe(false);
  });
});
