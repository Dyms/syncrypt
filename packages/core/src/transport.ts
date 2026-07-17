// Injectable HTTP transport — SHARED TYPES ONLY (RFC-0006 §Injectable
// transport). Providers sign/shape their protocol requests and dispatch them
// through an injected transport; clients supply platform-appropriate
// implementations (e.g. Obsidian's requestUrl() to bypass webview CORS).
// Pure interfaces: core still performs no I/O — default implementations live
// in the provider packages.

export interface HttpRequest {
  url: string;
  method: string;
  /** All request headers, including any auth the provider added. */
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
