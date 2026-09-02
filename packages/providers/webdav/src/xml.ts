// Minimal, namespace-agnostic PROPFIND multistatus parsing. WebDAV servers
// prefix DAV: elements differently (D:, d:, ns0:, or a default namespace), so
// matching is by LOCAL NAME. Covered by unit tests plus the live-server
// conformance run.
//
// The server is UNTRUSTED (threat model A1/A2/A3): every byte here is chosen
// by it. So this file reports what the response actually says, including when
// what it says is "that resource is not there" — a row this parser used to
// hand back as a perfectly good object (ADR-0039).

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

/**
 * Percent-decode a path one segment at a time. Shared with the client so the
 * base path and the hrefs it is compared against are decoded by the SAME rule
 * — comparing an encoded base against a decoded href matched nothing, silently
 * (ADR-0039).
 */
export function decodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg; // leave undecodable segments as-is
      }
    })
    .join("/");
}

/** `HTTP/1.1 207 Multi-Status` → 207. Null when there is no parsable status. */
function statusCode(raw: string | null): number | null {
  if (raw === null) return null;
  const m = /\s(\d{3})\s/.exec(` ${raw.trim()} `);
  return m?.[1] === undefined ? null : Number(m[1]);
}

const ok = (code: number | null): boolean => code === null || (code >= 200 && code < 300);

/** A finite number, or the fallback — never NaN out of a hostile response. */
function finite(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : fallback;
}

export interface DavEntry {
  /** Decoded absolute path from <href> (no scheme/host), no trailing slash. */
  path: string;
  /**
   * The server actually TOLD us something about this resource — at least one
   * `<propstat>` came back 2xx. A row whose every propstat failed says the
   * resource is mentioned, not that it is an object we can read: we know
   * neither its type nor its size. Believing one is how a dedup probe decides
   * a file is already uploaded when it is not (ADR-0039).
   */
  described: boolean;
  isCollection: boolean;
  size: number;
  etag: string;
  lastModified: number; // epoch seconds
}

/**
 * Parse a 207 multistatus body into entries.
 *
 * A `<response>` whose response-level `<status>` is non-2xx is DROPPED: the
 * server is saying that resource is not there, and treating it as present is
 * how a dedup probe decides not to upload a file. Props are read only from
 * 2xx `<propstat>` blocks, for the same reason.
 */
export function parseMultistatus(xml: string): DavEntry[] {
  const entries: DavEntry[] = [];
  const responseRe = new RegExp(`<${NS}response[^>]*>([\\s\\S]*?)</${NS}response>`, "gi");
  const propstatRe = new RegExp(`<${NS}propstat[^>]*>([\\s\\S]*?)</${NS}propstat>`, "gi");
  for (const m of xml.matchAll(responseRe)) {
    const block = m[1] ?? "";
    const rawHref = tagValue(block, "href");
    if (rawHref === null) continue;

    // Response-level status, i.e. everything outside any <propstat>.
    if (!ok(statusCode(tagValue(block.replace(propstatRe, ""), "status")))) continue;

    // Props are believed only from propstat blocks that succeeded. A server
    // with no propstat at all (rare, but legal for an error response we have
    // already let through) simply contributes nothing.
    const good = [...block.matchAll(propstatRe)].filter((p) =>
      ok(statusCode(tagValue(p[1] ?? "", "status"))),
    );
    const props = good.map((p) => p[1] ?? "").join("");

    let path = xmlUnescape(rawHref.trim());
    // href may be a full URL or an absolute path — keep only the path.
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
    // The trailing slash is the OTHER way a server says "collection", and the
    // one that does not depend on any property surviving the propstat filter.
    const trailingSlash = path.endsWith("/");
    path = decodePath(path);
    if (trailingSlash) path = path.replace(/\/+$/, "");

    entries.push({
      path,
      described: good.length > 0,
      isCollection: trailingSlash || new RegExp(`<${NS}collection(?:\\s[^>]*)?/?>`, "i").test(props),
      size: finite(tagValue(props, "getcontentlength"), 0),
      etag: xmlUnescape(tagValue(props, "getetag") ?? "").trim(),
      lastModified: finite(
        (() => {
          const raw = tagValue(props, "getlastmodified");
          if (raw === null) return null;
          const parsed = Date.parse(raw);
          return Number.isFinite(parsed) ? String(Math.floor(parsed / 1000)) : null;
        })(),
        0,
      ),
    });
  }
  return entries;
}

export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<propfind xmlns="DAV:"><prop>' +
  "<resourcetype/><getcontentlength/><getetag/><getlastmodified/>" +
  "</prop></propfind>";
