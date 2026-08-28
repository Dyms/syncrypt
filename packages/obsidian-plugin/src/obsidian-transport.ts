// HTTP transport backed by Obsidian's requestUrl() (RFC-0006 §Injectable
// transport): issues a NATIVE request, bypassing webview CORS — S3/MinIO do
// not send permissive CORS headers, so the renderer's fetch is blocked on
// both desktop and mobile. The request arrives here already signed.

import { requestUrl } from "obsidian";

import type { HttpTransport } from "@syncrypt/provider-s3";

export const obsidianTransport: HttpTransport = async (req) => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: toArrayBuffer(req.body) } : {}),
    throw: false, // status handling is the provider's job (error taxonomy)
  });
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers)) {
    headers[name.toLowerCase()] = value;
  }
  return {
    status: res.status,
    headers,
    body: readBody(res),
  };
};

/**
 * A response to HEAD (or a 204/304) has no body, and Obsidian's Android
 * implementation throws "Stream closed" when asked for one. Header-only
 * responses are normal, so treat a missing body as empty rather than fatal.
 */
function readBody(res: { status: number; arrayBuffer: ArrayBuffer }): Uint8Array {
  if (res.status === 204 || res.status === 304) return new Uint8Array(0);
  try {
    return new Uint8Array(res.arrayBuffer);
  } catch {
    return new Uint8Array(0);
  }
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}
