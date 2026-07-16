import type { KdfParams } from "@syncrypt/core";

/** Tiny Argon2id params: derivation speed is data, not code — tests stay fast. */
export const TEST_PARAMS: KdfParams = {
  kdf: "argon2id",
  version: 1,
  salt: "c2FsdHNhbHRzYWx0c2FsdA==", // "saltsaltsaltsalt"
  memoryKiB: 64,
  iterations: 1,
  parallelism: 1,
};

export const TEST_PRESET = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 64,
  iterations: 1,
  parallelism: 1,
} as const;
