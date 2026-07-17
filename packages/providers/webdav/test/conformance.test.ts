// RFC-0006 conformance for provider-webdav — the SAME shared suite the S3 and
// filesystem providers pass, with conditionalWrites=false. Runs against the
// in-process real WebDAV server everywhere; additionally against an external
// server (CI: Apache mod_dav container) when SYNCRYPT_WEBDAV_TEST_ENDPOINT is
// set.

import { describe, expect, it } from "vitest";

import type { StoragePort } from "@syncrypt/core";
import { describeStorageConformance } from "@syncrypt/core/testing/conformance";

import { WebDavClient, WebDavStorage } from "../src/index.js";
import { externalDavFromEnv, randomPrefixKeyed, startLocalDav, type LiveDav } from "./live-server.js";

// --- in-process real server (always runs) ----------------------------------

const running = new WeakMap<StoragePort, LiveDav>();

describeStorageConformance("webdav (in-process server, no conditional writes)", {
  async create(): Promise<StoragePort> {
    const dav = await startLocalDav();
    const storage = new WebDavStorage(dav.config);
    running.set(storage, dav);
    return storage;
  },
  async destroy(storage: StoragePort): Promise<void> {
    await running.get(storage)?.stop();
  },
});

describe("capabilities honesty", () => {
  it("advertises conditionalWrites=false (the ADR-0006 LIST path carries safety)", async () => {
    const dav = await startLocalDav();
    try {
      const caps = new WebDavStorage(dav.config).capabilities();
      expect(caps.conditionalWrites).toBe(false);
      expect(caps.objectVersioning).toBe(false);
      expect(caps.maxSinglePutBytes).toBeGreaterThan(0);
    } finally {
      await dav.stop();
    }
  });
});

// --- external server (CI Apache container; optional) ------------------------

const external = externalDavFromEnv();
if (external === null) {
  console.warn(
    "⚠ webdav external-server conformance SKIPPED — set SYNCRYPT_WEBDAV_TEST_ENDPOINT to run it.",
  );
} else {
  const base = external;
  describeStorageConformance("webdav (external server)", {
    async create(): Promise<StoragePort> {
      const config = randomPrefixKeyed(base);
      // The per-run collection must exist before first use.
      await new WebDavClient(config).sendOk({ method: "MKCOL", key: "", operation: "mkcol-base" });
      return new WebDavStorage(config);
    },
    async destroy(storage: StoragePort): Promise<void> {
      // WebDAV DELETE on a collection is recursive.
      const anyStorage = storage as WebDavStorage;
      void anyStorage;
      // Reconstructing the client is not possible from StoragePort — leave the
      // per-run collection behind; runs are uniquely named and tiny.
    },
  });
}
