// Injectable HTTP transport (RFC-0006 §Injectable transport).
//
// Signing and dispatch are decoupled: the client signs with aws4fetch, then
// hands the fully signed request to a transport. The default transport is the
// global fetch; the Obsidian client injects one backed by requestUrl(), which
// issues a native request and bypasses webview CORS (S3/MinIO buckets do not
// send permissive CORS headers).

export interface HttpRequest {
  url: string;
  method: string;
  /** All request headers, INCLUDING the SigV4 authorization headers. */
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  /** Header names lowercased. */
  headers: Record<string, string>;
  body: Uint8Array;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/** Default transport: the platform's global fetch. */
export const fetchTransport: HttpTransport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: (req.body ?? null) as Uint8Array<ArrayBuffer> | null,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return {
    status: res.status,
    headers,
    body: new Uint8Array(await res.arrayBuffer()),
  };
};
