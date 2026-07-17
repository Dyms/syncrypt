// Thin SigV4-signed fetch wrapper (ADR-0015: aws4fetch instead of the AWS SDK
// so the same provider can run in the Obsidian mobile webview).
//
// This layer only signs, sends, and normalizes failures. Retries live in
// storage.ts; XML in xml.ts. Credentials never leave the signer.

import { AwsClient } from "aws4fetch";

import { S3_DEFAULTS, type S3Config } from "./config.js";
import { normalizeNetworkError, normalizeS3Error, s3ErrorCode } from "./errors.js";

export interface S3Request {
  method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
  key: string; // object key, "" for bucket-level requests
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** For error messages, e.g. "put", "list". */
  operation: string;
}

export class S3Client {
  private readonly aws: AwsClient;
  private readonly baseUrl: string;

  constructor(config: S3Config) {
    this.aws = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
      service: "s3",
      region: config.region ?? S3_DEFAULTS.region,
    });
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

  /** Sign + send. Network failures normalize to StorageTransient. */
  async send(req: S3Request): Promise<Response> {
    try {
      // The cast keeps strict DOM lib types happy: our Uint8Arrays are always
      // ArrayBuffer-backed, which is a valid BodyInit.
      const body = (req.body ?? null) as string | Uint8Array<ArrayBuffer> | null;
      return await this.aws.fetch(this.urlFor(req.key, req.query), {
        method: req.method,
        headers: req.headers ?? {},
        // aws4fetch hashes the body into x-amz-content-sha256 (SigV4).
        body,
      });
    } catch (e) {
      throw normalizeNetworkError(e, req.key, req.operation);
    }
  }

  /** Send and demand success; on failure throw the normalized typed error. */
  async sendOk(req: S3Request): Promise<Response> {
    const res = await this.send(req);
    if (res.ok) return res;
    // HEAD responses have no body; otherwise the body may carry <Code>.
    const body = req.method === "HEAD" ? "" : await res.text().catch(() => "");
    throw normalizeS3Error(res.status, s3ErrorCode(body), req.key, req.operation);
  }
}
