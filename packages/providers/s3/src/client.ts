// SigV4 signing + dispatch through an injectable transport (ADR-0015,
// RFC-0006 §Injectable transport). This layer signs, sends, and normalizes
// failures. Retries live in storage.ts; XML in xml.ts. Credentials never
// leave the signer.

import { AwsV4Signer } from "aws4fetch";

import { S3_DEFAULTS, type S3Config } from "./config.js";
import { normalizeNetworkError, normalizeS3Error, s3ErrorCode } from "./errors.js";
import { fetchTransport, type HttpTransport } from "./transport.js";

export interface S3Request {
  method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
  key: string; // object key, "" for bucket-level requests
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** For error messages, e.g. "put", "list". */
  operation: string;
}

/** Normalized response: body fully read, header names lowercased. */
export class S3Response {
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

export class S3Client {
  private readonly credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  private readonly region: string;
  private readonly baseUrl: string;
  private readonly transport: HttpTransport;

  constructor(config: S3Config) {
    this.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
    };
    this.region = config.region ?? S3_DEFAULTS.region;
    this.transport = config.transport ?? fetchTransport;
    const url = new URL(config.endpoint);
    const pathStyle = config.forcePathStyle ?? S3_DEFAULTS.forcePathStyle;
    this.baseUrl = pathStyle
      ? `${url.origin}/${config.bucket}`
      : `${url.protocol}//${config.bucket}.${url.host}`;
  }

  urlFor(key: string, query?: Record<string, string>): string {
    const encodedKey = key
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    const q = new URLSearchParams(query).toString();
    return `${this.baseUrl}/${encodedKey}${q === "" ? "" : `?${q}`}`;
  }

  /** Sign, then dispatch via the transport. Network failures → Transient. */
  async send(req: S3Request): Promise<S3Response> {
    const url = this.urlFor(req.key, req.query);
    const body =
      typeof req.body === "string" ? new TextEncoder().encode(req.body) : req.body;
    try {
      // Sign only — the transport does the I/O (RFC-0006: decouple signing
      // from dispatch so Obsidian can route through requestUrl()).
      // x-amz-content-sha256 is computed HERE as a real payload hash and
      // pre-set before signing: aws4fetch would otherwise default S3 requests
      // to UNSIGNED-PAYLOAD, which stricter backends/policies reject.
      const signer = new AwsV4Signer({
        url,
        method: req.method,
        headers: {
          ...req.headers,
          "x-amz-content-sha256": await sha256Hex(body ?? new Uint8Array(0)),
        },
        body: (body ?? null) as Uint8Array<ArrayBuffer> | null,
        service: "s3",
        region: this.region,
        ...this.credentials,
      });
      const signed = await signer.sign();
      const headers: Record<string, string> = {};
      signed.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const res = await this.transport({
        url: signed.url.toString(),
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      return new S3Response(res.status, res.headers, res.body);
    } catch (e) {
      throw normalizeNetworkError(e, req.key, req.operation);
    }
  }

  /** Send and demand success; on failure throw the normalized typed error. */
  async sendOk(req: S3Request): Promise<S3Response> {
    const res = await this.send(req);
    if (res.ok) return res;
    throw normalizeS3Error(res.status, s3ErrorCode(res.text()), req.key, req.operation);
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
