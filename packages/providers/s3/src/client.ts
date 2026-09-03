// SigV4 signing + dispatch through an injectable transport (ADR-0015,
// RFC-0006 §Injectable transport). This layer signs, sends, and normalizes
// failures. Retries live in storage.ts; XML in xml.ts. Credentials never
// leave the signer.

import { AwsV4Signer } from "aws4fetch";

import { SyncError } from "@syncrypt/core";

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
    // No caller in the engine produces a traversing key, so one arriving here
    // came out of a listing — which is the server talking (ADR-0039). It must
    // not become a URL: `encodeURIComponent` leaves ".." intact, and the
    // `new URL()` inside the signer then normalizes it away, so
    // "vaults/main/objects/../../../manifests/000000009-devA.json" is signed
    // and dispatched as "/manifests/000000009-devA.json". Reclamation's
    // "never outside objects/" is a prefix test on a string the server chose.
    if (key !== "" && !safeKey(key)) {
      throw new SyncError("StorageTransient", `S3: refusing unsafe key "${key}"`);
    }
    const encodedKey = key
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    const q = encodeQuery(query);
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

/** A key we are willing to turn into a URL: no empty, "." or ".." segments. */
function safeKey(key: string): boolean {
  return key.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * RFC-3986 percent-encoding, which is what SigV4 canonicalizes a query with
 * and what S3 matches a `prefix=` against.
 *
 * `URLSearchParams` writes application/x-www-form-urlencoded instead: a space
 * becomes "+", and "~" and "*" are escaped. aws4fetch builds the canonical
 * request from the DECODED `url.searchParams` and re-encodes per RFC 3986, so
 * the string that gets signed and the string that goes on the wire are not the
 * same one. A vault prefix with a space in it — "Мои заметки" — was signed as
 * %20 and sent as +:
 *
 *   a backend that checks the signature answers 403 SignatureDoesNotMatch;
 *   a backend that does not compares "Мои+заметки/" literally and finds
 *   nothing, so `readRemote` sees generation 0 on a vault full of data.
 *
 * put/get/stat/delete kept working throughout, because they build a path and
 * not a query — the same shape of silence as the WebDAV base-path defect in
 * ADR-0039, and with the same consequence: an ADR-0038 refusal for ever on a
 * device that has a base, an empty vault on one that does not.
 */
function encodeQuery(query?: Record<string, string>): string {
  if (query === undefined) return "";
  return Object.entries(query)
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");
}

function rfc3986(raw: string): string {
  return encodeURIComponent(raw).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  // Fresh copy: guaranteed ArrayBuffer-backed (a valid BufferSource under
  // both the minimal and the Node/DOM WebCrypto typings).
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
