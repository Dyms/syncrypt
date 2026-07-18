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
    body: new Uint8Array(res.arrayBuffer),
  };
};

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}
