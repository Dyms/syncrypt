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
    const lastModified = tagValue(block, "LastModified");
    contents.push({
      key: decodeURIComponent(xmlUnescape(rawKey).replaceAll("+", "%20")),
      size: Number(tagValue(block, "Size") ?? "0"),
      etag: xmlUnescape(tagValue(block, "ETag") ?? ""),
      lastModified:
        lastModified !== null ? Math.floor(Date.parse(lastModified) / 1000) : 0,
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
