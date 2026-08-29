// When do we tell the user their credentials are travelling in the clear?
//
// Both mistakes are real: staying silent about a plaintext endpoint hands the
// storage keys to anyone on the network, and crying wolf about a local MinIO
// teaches people to ignore the warning that matters.

import { describe, expect, it } from "vitest";

import { endpointIsPlaintext } from "../src/endpoint-warning.js";

describe("plaintext endpoint warning", () => {
  it("warns about plain http to anywhere off this machine", () => {
    for (const url of [
      "http://s3.example.com",
      "http://192.168.1.10:9000",
      "http://nas.local:5005/dav",
      "HTTP://S3.EXAMPLE.COM",
      "  http://s3.example.com  ",
    ]) {
      expect(endpointIsPlaintext(url), url).toBe(true);
    }
  });

  it("stays quiet for https", () => {
    for (const url of [
      "https://s3.example.com",
      "https://account.r2.cloudflarestorage.com",
      "",
    ]) {
      expect(endpointIsPlaintext(url), url).toBe(false);
    }
  });

  it("stays quiet for loopback — a local MinIO is how people test", () => {
    for (const url of [
      "http://localhost:9000",
      "http://127.0.0.1:9000",
      "http://127.1.2.3:9000",
      "http://[::1]:9000",
      "http://minio.localhost:9000",
    ]) {
      expect(endpointIsPlaintext(url), url).toBe(false);
    }
  });

  it("says nothing while the user is still typing", () => {
    for (const url of ["http://", "http://:::", "not a url"]) {
      expect(endpointIsPlaintext(url), url).toBe(false);
    }
  });
});
