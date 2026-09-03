// Minimal XML handling for the exact S3 responses we consume (ADR-0015):
// ListObjectsV2, InitiateMultipartUpload, CompleteMultipartUpload. We always
// request `encoding-type=url`, so keys arrive URL-encoded and XML entities in
// them are a non-issue after unescaping the five standard entities.

export function xmlUnescape(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&"); // last, so "&amp;lt;" round-trips correctly
}

export function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tagValue(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return m?.[1] ?? null;
}

/** A finite number, or the fallback — never NaN out of a hostile response. */
function finite(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : fallback;
}

/** Epoch seconds from an HTTP date, or 0 — an unparsable date is not a time. */
function lastModifiedSeconds(raw: string | null): number {
  if (raw === null) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Decode a key from an `encoding-type=url` listing, or null if it will not
 * decode. A malformed percent-escape ("objects/%zz") used to throw `URIError`
 * out of the middle of `list()` — not a SyncError, no code, straight past the
 * retry logic and the RFC-0007 taxonomy and into the UI. A row we cannot read
 * is a row we skip: an object missing from a listing is never a deletion
 * candidate and never a manifest we act on, so the direction is safe.
 */
function decodeKey(raw: string): string | null {
  try {
    return decodeURIComponent(xmlUnescape(raw).replaceAll("+", "%20"));
  } catch {
    return null;
  }
}

export interface ListedObject {
  key: string; // URL-decoded, ready to use
  size: number;
  etag: string;
  lastModified: number; // epoch seconds
}

export interface ListObjectsV2Page {
  contents: ListedObject[];
  isTruncated: boolean;
  nextContinuationToken: string | null;
}

/** Parse a ListObjectsV2 response requested with encoding-type=url. */
export function parseListObjectsV2(xml: string): ListObjectsV2Page {
  const contents: ListedObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1] ?? "";
    const rawKey = tagValue(block, "Key");
    if (rawKey === null) continue;
    const key = decodeKey(rawKey);
    if (key === null) continue;
    contents.push({
      key,
      // Clamped to finite. A hostile or garbled length is 0, not NaN: NaN
      // propagates into the byte total the reclaim dialog shows before the one
      // irreversible operation in the product, and "NaN MB" is not a number a
      // person can consent to (ADR-0039).
      size: finite(tagValue(block, "Size"), 0),
      etag: xmlUnescape(tagValue(block, "ETag") ?? ""),
      lastModified: lastModifiedSeconds(tagValue(block, "LastModified")),
    });
  }
  return {
    contents,
    isTruncated: tagValue(xml, "IsTruncated") === "true",
    nextContinuationToken: tagValue(xml, "NextContinuationToken"),
  };
}

export function parseInitiateMultipartUpload(xml: string): string | null {
  return tagValue(xml, "UploadId");
}

export function buildCompleteMultipartUpload(
  parts: { partNumber: number; etag: string }[],
): string {
  const body = parts
    .map(
      (p) =>
        `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`,
    )
    .join("");
  return `<CompleteMultipartUpload>${body}</CompleteMultipartUpload>`;
}

/** CompleteMultipartUpload can return HTTP 200 with an embedded <Error>. */
export function embeddedErrorCode(xml: string): string | null {
  return /<Error>[\s\S]*?<\/Error>/.test(xml) ? (tagValue(xml, "Code") ?? "InternalError") : null;
}
