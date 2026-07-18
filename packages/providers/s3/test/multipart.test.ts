// Live multipart round-trip: an object above the threshold goes up in parts
// and comes back byte-identical (RFC-0006 §Multipart upload).

import { describe, expect, it } from "vitest";

import { S3Storage } from "../src/index.js";
import { createBucket, deleteBucketRecursive } from "../src/testing.js";
import { bucketConfig, liveS3FromEnv, warnSkipped } from "./live.js";

const live = liveS3FromEnv();

if (live === null) {
  warnSkipped("provider-s3 multipart");
  describe.skip("multipart (no live backend)", () => {
    it.skip("requires SYNCRYPT_S3_TEST_ENDPOINT", () => undefined);
  });
} else {
  describe("multipart upload (live)", () => {
    it("round-trips a 12 MiB object in 5 MiB parts", async () => {
      const config = bucketConfig(live, {
        multipartThresholdBytes: 5 * 1024 * 1024,
        partSizeBytes: 5 * 1024 * 1024,
      });
      await createBucket(config);
      try {
        const storage = await S3Storage.create(config);
        // Deterministic pseudo-random content, 12 MiB → 3 parts (5+5+2).
        const data = new Uint8Array(12 * 1024 * 1024);
        for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;

        const { etag } = await storage.put("attachments/big.bin", data);
        expect(etag.length).toBeGreaterThan(0);

        const back = await storage.get("attachments/big.bin");
        expect(back.length).toBe(data.length);
        expect(back).toEqual(data);

        const stat = await storage.stat("attachments/big.bin");
        expect(stat.size).toBe(data.length);
      } finally {
        await deleteBucketRecursive(config);
      }
    }, 120_000);
  });
}
