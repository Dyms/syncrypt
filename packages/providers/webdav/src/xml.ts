// Minimal, namespace-agnostic PROPFIND multistatus parsing. WebDAV servers
// prefix DAV: elements differently (D:, d:, ns0:, or a default namespace), so
// matching is by LOCAL NAME. Covered by unit tests plus the live-server
// conformance run.

const NS = "(?:[A-Za-z0-9_-]+:)?";

function tagValue(block: string, localName: string): string | null {
  const re = new RegExp(`<${NS}${localName}[^>]*>([\\s\\S]*?)</${NS}${localName}>`, "i");
  return re.exec(block)?.[1] ?? null;
}

export function xmlUnescape(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

export interface DavEntry {
  /** Decoded absolute path from <href> (no scheme/host), no trailing slash. */
  path: string;
  isCollection: boolean;
  size: number;
  etag: string;
  lastModified: number; // epoch seconds
}

/** Parse a 207 multistatus body into entries. */
export function parseMultistatus(xml: string): DavEntry[] {
  const entries: DavEntry[] = [];
  const responseRe = new RegExp(`<${NS}response[^>]*>([\\s\\S]*?)</${NS}response>`, "gi");
  for (const m of xml.matchAll(responseRe)) {
    const block = m[1] ?? "";
    const rawHref = tagValue(block, "href");
    if (rawHref === null) continue;
    let path = xmlUnescape(rawHref.trim());
    // href may be a full URL or an absolute path — keep only the path.
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
    path = path
      .split("/")
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg; // leave undecodable segments as-is
        }
      })
      .join("/");
    const isCollection = new RegExp(`<${NS}collection\\s*/?>`, "i").test(block);
    if (path.endsWith("/")) path = path.slice(0, -1);

    // A response may carry a 404 propstat (e.g. missing props) — the entry
    // still exists; only a top-level 404 status means gone, which servers
    // express with an HTTP 404, not a multistatus row.
    const lastModifiedRaw = tagValue(block, "getlastmodified");
    entries.push({
      path,
      isCollection,
      size: Number(tagValue(block, "getcontentlength") ?? "0"),
      etag: xmlUnescape(tagValue(block, "getetag") ?? "").trim(),
      lastModified:
        lastModifiedRaw !== null ? Math.floor(Date.parse(lastModifiedRaw) / 1000) : 0,
    });
  }
  return entries;
}

export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<propfind xmlns="DAV:"><prop>' +
  "<resourcetype/><getcontentlength/><getetag/><getlastmodified/>" +
  "</prop></propfind>";
