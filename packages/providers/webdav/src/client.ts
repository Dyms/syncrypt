// WebDAV HTTP layer: auth header + dispatch through the injectable transport
// (RFC-0006 §Injectable transport) + error normalization to the RFC-0007
// taxonomy. Credentials appear ONLY in the Authorization header.

import { SyncError, type HttpTransport, type SyncErrorCode } from "@syncrypt/core";

import type { WebDavConfig } from "./config.js";

/** Local default transport (same shape as provider-s3's; providers stay independent). */
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
  return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
};

export class DavResponse {
  constructor(
    readonly status: number,
    private readonly headers: Record<string, string>,
    private readonly bodyBytes: Uint8Array,
  ) {}

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  header(name: string): string | null {
    return this.headers[name.toLowerCase()] ?? null;
  }

  bytes(): Uint8Array {
    return this.bodyBytes;
  }

  text(): string {
    return new TextDecoder().decode(this.bodyBytes);
  }
}

export interface DavRequest {
  method: "GET" | "PUT" | "DELETE" | "PROPFIND" | "MKCOL";
  /** Storage-relative key ("" for the root collection). */
  key: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  operation: string;
}

export function normalizeDavError(status: number, key: string, operation: string): SyncError {
  const detail = `WebDAV ${operation} "${key}": HTTP ${status}`;
  const code: SyncErrorCode =
    status === 404
      ? "StorageNotFound"
      : status === 401 || status === 403
        ? "StorageUnauthorized"
        : status === 412
          ? "StoragePreconditionFailed"
          : status === 429
            ? "StorageRateLimited"
            : "StorageTransient"; // 409, 423 Locked, 5xx… retry or surface upstream
  return new SyncError(code, detail);
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export class WebDavClient {
  private readonly transport: HttpTransport;
  private readonly baseUrl: string;
  readonly basePath: string;
  private readonly authHeader: string | null;

  constructor(config: WebDavConfig) {
    this.transport = config.transport ?? fetchTransport;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.basePath = new URL(this.baseUrl).pathname.replace(/\/+$/, "");
    this.authHeader =
      config.bearerToken !== undefined
        ? `Bearer ${config.bearerToken}`
        : config.username !== undefined
          ? `Basic ${base64(`${config.username}:${config.password ?? ""}`)}`
          : null;
  }

  urlFor(key: string): string {
    if (key === "") return this.baseUrl;
    const encoded = key
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    return `${this.baseUrl}/${encoded}`;
  }

  /** Storage-relative key for an absolute DAV path from a multistatus href. */
  keyFor(davPath: string): string {
    const path = davPath.replace(/\/+$/, "");
    if (path === this.basePath) return "";
    return path.startsWith(`${this.basePath}/`)
      ? path.slice(this.basePath.length + 1)
      : path.replace(/^\/+/, "");
  }

  async send(req: DavRequest): Promise<DavResponse> {
    const body =
      typeof req.body === "string" ? new TextEncoder().encode(req.body) : req.body;
    try {
      const res = await this.transport({
        url: this.urlFor(req.key),
        method: req.method,
        headers: {
          ...(this.authHeader !== null ? { authorization: this.authHeader } : {}),
          ...req.headers,
        },
        ...(body !== undefined ? { body } : {}),
      });
      return new DavResponse(res.status, res.headers, res.body);
    } catch (e) {
      if (e instanceof SyncError) throw e;
      // String(e) on transport errors carries no request data (and never credentials).
      throw new SyncError(
        "StorageTransient",
        `WebDAV ${req.operation} "${req.key}": network error (${String(e)})`,
        e,
      );
    }
  }

  async sendOk(req: DavRequest): Promise<DavResponse> {
    const res = await this.send(req);
    if (res.ok) return res;
    throw normalizeDavError(res.status, req.key, req.operation);
  }
}
