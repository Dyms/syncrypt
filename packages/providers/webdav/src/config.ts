// WebDAV provider configuration (RFC-0006 §Future providers).
// Credentials are SECRETS: they live only here and in the Authorization
// header — never in logs, error messages, or the manifest.

import type { HttpTransport } from "@syncrypt/core";

export interface WebDavRetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface WebDavConfig {
  /** Collection URL that is the vault's storage root, e.g.
   *  "https://cloud.example.com/remote.php/dav/files/user/syncrypt". */
  baseUrl: string;
  /** Basic auth (Nextcloud app passwords, Apache htpasswd, …). */
  username?: string;
  password?: string;
  /** OR Bearer auth (OAuth-fronted DAV). */
  bearerToken?: string;
  /** RFC-0006 injectable transport; default: global fetch. */
  transport?: HttpTransport;
  retry?: WebDavRetryConfig;
  /** No multipart in WebDAV — one PUT per object (default 2 GiB advisory cap). */
  maxSinglePutBytes?: number;
}

export const WEBDAV_DEFAULTS = {
  maxRetries: 4,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  maxSinglePutBytes: 2 * 1024 * 1024 * 1024,
} as const;
