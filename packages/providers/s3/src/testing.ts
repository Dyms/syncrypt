// Test-harness helpers: bucket lifecycle (deliberately NOT part of StoragePort
// — Syncrypt never creates or deletes buckets on a user's behalf).

import { S3Client } from "./client.js";
import type { S3Config } from "./config.js";
import { S3Storage } from "./storage.js";

export async function createBucket(config: S3Config): Promise<void> {
  const client = new S3Client(config);
  const res = await client.send({ method: "PUT", key: "", operation: "create-bucket" });
  await res.body?.cancel();
  if (!res.ok && res.status !== 409) {
    // 409 BucketAlreadyOwnedByYou is fine for tests
    throw new Error(`create-bucket "${config.bucket}" failed: HTTP ${res.status}`);
  }
}

export async function deleteBucketRecursive(config: S3Config): Promise<void> {
  const storage = await S3Storage.create({ ...config, conditionalWrites: false });
  const keys: string[] = [];
  for await (const stat of storage.list("")) keys.push(stat.key);
  for (const key of keys) await storage.delete(key);
  const client = new S3Client(config);
  const res = await client.send({ method: "DELETE", key: "", operation: "delete-bucket" });
  await res.body?.cancel();
}
