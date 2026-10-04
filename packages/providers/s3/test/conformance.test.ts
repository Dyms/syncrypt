// RFC-0006 conformance for @syncrypt/provider-s3 against a LIVE S3-compatible
// backend (MinIO), in both capability modes:
//  - probed (exercises real conditional writes when the backend honors them),
//  - forced-off (exercises the universal subset the ADR-0006 protocol needs).

import { describe, expect, it } from "vitest";

import type { StoragePort } from "@syncrypt/core";
import { describeStorageConformance } from "@syncrypt/core/testing/conformance";

import { fetchTransport, S3Storage } from "../src/index.js";
import type { HttpTransport } from "../src/transport.js";
import type { S3Config } from "../src/config.js";
import { createBucket, deleteBucketRecursive } from "../src/testing.js";
import { bucketConfig, liveS3FromEnv, warnSkipped } from "./live.js";

const live = liveS3FromEnv();

if (live === null) {
  warnSkipped("provider-s3 conformance");
  describe.skip("StorageProvider conformance: s3 (no live backend)", () => {
    it.skip("requires SYNCRYPT_S3_TEST_ENDPOINT", () => undefined);
  });
} else {
  const configs = new WeakMap<StoragePort, S3Config>();

  const PAGE_SIZE = 10;

  const harness = (overrides: Partial<S3Config>) => ({
    // What the suite writes more than two pages of (ADR-0058). Declared here
    // rather than guessed, so the continuation branch is exercised whatever
    // the production default is.
    listPageSize: PAGE_SIZE,
    async create(): Promise<StoragePort> {
      const config = bucketConfig(live, overrides);
      await createBucket(config);
      const storage = await S3Storage.create(config);
      configs.set(storage, config);
      return storage;
    },
    async destroy(storage: StoragePort): Promise<void> {
      const config = configs.get(storage);
      if (config !== undefined) await deleteBucketRecursive(config);
    },
  });

  /**
   * Obsidian's `requestUrl()` on Android cannot issue a HEAD — it fails with
   * "IOException Stream closed". stat() detects that and degrades to a
   * byte-range GET for the rest of the session, which means a whole shape of
   * request has always been the NORMAL one on a real platform and was never
   * under conformance. The empty-ETag answer on a zero-byte object (B2,
   * ADR-0056) lived in exactly that shape.
   *
   * So the suite runs again over a transport that behaves like Android's
   * (ADR-0058). No production code knows about this: a transport that refuses
   * HEAD is a condition, not a mode.
   */
  const headlessTransport: HttpTransport = (req) =>
    req.method === "HEAD"
      ? Promise.reject(new Error("Request Failed. IOException Stream closed"))
      : fetchTransport(req);

  // A small page size so the continuation-token branch is exercised by the
  // pagination test rather than sitting unreached behind max-keys=1000.
  describeStorageConformance(
    "s3/MinIO (probed capabilities)",
    harness({ listPageSize: PAGE_SIZE }),
  );
  describeStorageConformance(
    "s3/MinIO (universal subset only)",
    harness({ conditionalWrites: false, listPageSize: PAGE_SIZE }),
  );

  describeStorageConformance(
    "s3/MinIO (no HEAD — the Android request shape)",
    harness({ listPageSize: PAGE_SIZE, transport: headlessTransport }),
  );

  describe("capability probe against the live backend", () => {
    it("probe result is reported and consistent with observed behavior", async () => {
      const config = bucketConfig(live);
      await createBucket(config);
      try {
        const storage = await S3Storage.create(config);
        const caps = storage.capabilities();
        // Whatever the backend is, the report must match actual behavior:
        await storage.put("probe-check", new TextEncoder().encode("x"));
        let rejected = false;
        try {
          await storage.put("probe-check", new TextEncoder().encode("y"), {
            ifNoneMatch: "*",
          });
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(caps.conditionalWrites);
      } finally {
        await deleteBucketRecursive(config);
      }
    });
  });
}
