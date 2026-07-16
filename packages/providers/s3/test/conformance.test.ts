// RFC-0006 conformance for @syncrypt/provider-s3 against a LIVE S3-compatible
// backend (MinIO), in both capability modes:
//  - probed (exercises real conditional writes when the backend honors them),
//  - forced-off (exercises the universal subset the ADR-0006 protocol needs).

import { describe, expect, it } from "vitest";

import type { StoragePort } from "@syncrypt/core";
import { describeStorageConformance } from "@syncrypt/core/testing/conformance";

import { S3Storage } from "../src/index.js";
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

  const harness = (overrides: Partial<S3Config>) => ({
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

  describeStorageConformance("s3/MinIO (probed capabilities)", harness({}));
  describeStorageConformance(
    "s3/MinIO (universal subset only)",
    harness({ conditionalWrites: false }),
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
