#!/usr/bin/env node
// Syncrypt manual recovery — decrypt a vault WITHOUT Syncrypt (crypto format v1).
// See manual-recovery.md. This is the proof of "user owns the data".
//
// Usage:
//   npm install hash-wasm        # the only dependency (Argon2id, WASM)
//   SYNCRYPT_PASSPHRASE=... node recover.mjs <downloaded-prefix-dir> [out-dir]
//
// <downloaded-prefix-dir> must contain meta/keyfile-params.json, manifests/, objects/.

import { argon2id } from "hash-wasm";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

const ROOT = process.argv[2] ?? ".";
const OUT = process.argv[3] ?? "restored";
const passphrase = process.env.SYNCRYPT_PASSPHRASE;
if (!passphrase) {
  console.error("Set SYNCRYPT_PASSPHRASE in the environment (avoids shell history).");
  process.exit(1);
}

// --- key derivation (RFC-0005 §Key hierarchy) -------------------------------
const params = JSON.parse(await readFile(path.join(ROOT, "meta", "keyfile-params.json"), "utf8"));
if (params.kdf !== "argon2id" || params.version !== 1) throw new Error("unsupported keyfile-params");

const masterKey = await argon2id({
  password: passphrase,
  salt: Buffer.from(params.salt, "base64"), // salt is standard base64
  iterations: params.iterations,
  memorySize: params.memoryKiB,
  parallelism: params.parallelism,
  hashLength: 32,
  outputType: "binary",
});

const hkdfKey = await crypto.subtle.importKey("raw", masterKey, "HKDF", false, ["deriveBits"]);
async function subkey(info) {
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) },
    hkdfKey,
    256,
  );
  return crypto.subtle.importKey("raw", new Uint8Array(bits), { name: "AES-GCM" }, false, ["decrypt"]);
}
const contentKey = await subkey("syncrypt/content");
const manifestKey = await subkey("syncrypt/manifest");

// --- blob v1 (RFC-0005 §File object format) ---------------------------------
async function decrypt(blob, key) {
  const magic = Buffer.from(blob.subarray(0, 4)).toString();
  if (magic !== "SYNC" || blob[4] !== 1 || blob[5] !== 1) throw new Error("unsupported blob");
  const header = blob.subarray(0, 18); // magic|version|alg|nonce = the GCM AAD
  const nonce = blob.subarray(6, 18);
  const ciphertextAndTag = blob.subarray(18);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: header, tagLength: 128 },
    key,
    ciphertextAndTag,
  );
  return new Uint8Array(plaintext);
}

// --- newest manifest = highest generation; on a fork, smallest deviceId wins --
const names = (await readdir(path.join(ROOT, "manifests"))).filter((n) => /^\d+-.+\.json$/.test(n));
if (names.length === 0) throw new Error("no manifests found");
const parse = (n) => {
  const m = /^(\d+)-(.+)\.json$/.exec(n);
  return { gen: Number(m[1]), device: m[2], name: n };
};
const top = Math.max(...names.map((n) => parse(n).gen));
const newest = names
  .map(parse)
  .filter((r) => r.gen === top)
  .sort((a, b) => (a.device < b.device ? -1 : 1))[0].name;

const manifest = JSON.parse(
  new TextDecoder().decode(await decrypt(await readFile(path.join(ROOT, "manifests", newest)), manifestKey)),
);
console.log(`manifest ${newest}: generation ${manifest.generation}, ${Object.keys(manifest.files).length} files`);

// --- restore ------------------------------------------------------------------
for (const [file, entry] of Object.entries(manifest.files)) {
  if (path.isAbsolute(file) || file.split("/").includes("..")) {
    console.warn(`skipping suspicious path: ${file}`);
    continue;
  }
  const blob = await readFile(path.join(ROOT, ...entry.objectKey.split("/")));
  const data = await decrypt(blob, contentKey);
  const dest = path.join(OUT, ...file.split("/"));
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, data);
  console.log("restored", file);
}
console.log("done →", OUT);
