#!/usr/bin/env node
// Argon2id parameter benchmark (RFC-0005 §Unresolved: default params).
// Run: node scripts/bench-argon2id.mjs
// Measures wall-clock derivation time for candidate parameter sets using the
// same library (hash-wasm) the product uses. Pick desktop defaults targeting
// ~0.5–1 s unlock; the mobile profile trades memory for an extra pass.

import { argon2id } from "hash-wasm";
import { cpus } from "node:os";

const candidates = [
  { label: "OWASP minimum", memoryKiB: 19456, iterations: 2, parallelism: 1 },
  { label: "32 MiB / t=3", memoryKiB: 32768, iterations: 3, parallelism: 1 },
  { label: "32 MiB / t=4 (mobile candidate)", memoryKiB: 32768, iterations: 4, parallelism: 1 },
  { label: "64 MiB / t=2", memoryKiB: 65536, iterations: 2, parallelism: 1 },
  { label: "64 MiB / t=3 (desktop candidate)", memoryKiB: 65536, iterations: 3, parallelism: 1 },
  { label: "128 MiB / t=3", memoryKiB: 131072, iterations: 3, parallelism: 1 },
  { label: "256 MiB / t=3", memoryKiB: 262144, iterations: 3, parallelism: 1 },
];

const salt = new Uint8Array(16).fill(7);
const passphrase = "benchmark passphrase (not a secret)";
const RUNS = 3;

console.log(`node ${process.version} · ${cpus()[0]?.model ?? "unknown CPU"} · ${cpus().length} threads\n`);
console.log("params".padEnd(38), "median of", RUNS);
for (const c of candidates) {
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await argon2id({
      password: passphrase,
      salt,
      iterations: c.iterations,
      memorySize: c.memoryKiB,
      parallelism: c.parallelism,
      hashLength: 32,
      outputType: "binary",
    });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(
    `${c.label.padEnd(38)} ${median.toFixed(0).padStart(6)} ms   (m=${c.memoryKiB} KiB, t=${c.iterations}, p=${c.parallelism})`,
  );
}
