import type { KdfParams } from "@syncrypt/core";

/**
 * Fast-but-valid Argon2id params for tests: exactly at the ADR-0014 floor
 * (the OWASP reference minimum, ~40 ms per derivation) — anything weaker is
 * rejected by validateKdfParams.
 */
export const TEST_PARAMS: KdfParams = {
  kdf: "argon2id",
  version: 1,
  salt: "c2FsdHNhbHRzYWx0c2FsdA==", // "saltsaltsaltsalt"
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
};

export const TEST_PRESET = {
  kdf: "argon2id",
  version: 1,
  memoryKiB: 19456,
  iterations: 2,
  parallelism: 1,
} as const;
