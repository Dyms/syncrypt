// Manifest model — RFC-0004 §The manifest, RFC-0007 §1, ADR-0006.
//
// Parsing FAILS CLOSED: anything structurally wrong throws
// SyncError("ManifestCorrupt") and the data is never applied.
// Serialization is canonical (sorted keys) so identical manifests are
// byte-identical on every device.

import { SyncError } from "./errors.js";
import { isCanonicalPath } from "./paths.js";
import type {
  DeviceId,
  Manifest,
  ManifestEntry,
  ObjectKey,
  Tombstone,
  VaultPath,
} from "./types.js";

export const MANIFESTS_PREFIX = "manifests/";
/** Zero-pad width for generations in manifest keys (lexicographic = numeric order). */
const GENERATION_PAD = 9;

/** "manifests/000000042-<deviceId>.json" — immutable per-generation object (ADR-0006). */
export function manifestKey(generation: number, device: DeviceId): ObjectKey {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new SyncError("ManifestCorrupt", `invalid generation: ${generation}`);
  }
  return `${MANIFESTS_PREFIX}${String(generation).padStart(GENERATION_PAD, "0")}-${device}.json`;
}

/** Parse a manifest object key back into (generation, deviceId); null if foreign. */
export function parseManifestKey(
  key: ObjectKey,
): { generation: number; device: DeviceId } | null {
  const name = key.startsWith(MANIFESTS_PREFIX)
    ? key.slice(MANIFESTS_PREFIX.length)
    : null;
  if (!name?.endsWith(".json")) return null;
  const m = /^(\d+)-(.+)\.json$/.exec(name);
  if (!m?.[1] || !m[2]) return null;
  const generation = Number(m[1]);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  return { generation, device: m[2] };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Canonical JSON: object keys sorted at every level, no insignificant whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

export function serializeManifest(manifest: Manifest): Uint8Array {
  return textEncoder.encode(canonicalJson(manifest));
}

function corrupt(detail: string): SyncError {
  return new SyncError("ManifestCorrupt", `manifest corrupt: ${detail}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEpochSeconds(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function validateEntry(path: string, v: unknown): ManifestEntry {
  if (!isRecord(v)) throw corrupt(`entry for "${path}" is not an object`);
  const { hash, size, mtime, objectKey } = v;
  if (typeof hash !== "string" || !hash.includes(":")) {
    throw corrupt(`entry for "${path}" has invalid hash`);
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    throw corrupt(`entry for "${path}" has invalid size`);
  }
  if (!isEpochSeconds(mtime)) throw corrupt(`entry for "${path}" has invalid mtime`);
  if (typeof objectKey !== "string" || objectKey.length === 0) {
    throw corrupt(`entry for "${path}" has invalid objectKey`);
  }
  return { hash, size, mtime, objectKey };
}

function validateTombstone(path: string, v: unknown): Tombstone {
  if (!isRecord(v)) throw corrupt(`tombstone for "${path}" is not an object`);
  const { deletedAt, device } = v;
  if (!isEpochSeconds(deletedAt)) {
    throw corrupt(`tombstone for "${path}" has invalid deletedAt`);
  }
  if (typeof device !== "string" || device.length === 0) {
    throw corrupt(`tombstone for "${path}" has invalid device`);
  }
  return { deletedAt, device };
}

function validatePath(path: string, where: string): VaultPath {
  if (!isCanonicalPath(path)) {
    throw corrupt(`non-canonical path in ${where}: "${path}"`);
  }
  return path;
}

/** Parse + strictly validate manifest bytes. Fail-closed: throws ManifestCorrupt. */
export function parseManifest(bytes: Uint8Array): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(textDecoder.decode(bytes));
  } catch (e) {
    throw new SyncError("ManifestCorrupt", "manifest corrupt: not valid JSON", e);
  }
  if (!isRecord(raw)) throw corrupt("root is not an object");
  if (raw.version !== 1) throw corrupt(`unsupported version: ${String(raw.version)}`);
  if (
    typeof raw.generation !== "number" ||
    !Number.isSafeInteger(raw.generation) ||
    raw.generation < 1
  ) {
    throw corrupt("invalid generation");
  }
  if (typeof raw.device !== "string" || raw.device.length === 0) {
    throw corrupt("invalid device");
  }
  if (!isEpochSeconds(raw.updatedAt)) throw corrupt("invalid updatedAt");
  if (!isRecord(raw.files)) throw corrupt("files is not an object");
  if (!isRecord(raw.tombstones)) throw corrupt("tombstones is not an object");

  const files: Record<VaultPath, ManifestEntry> = {};
  for (const [path, entry] of Object.entries(raw.files)) {
    files[validatePath(path, "files")] = validateEntry(path, entry);
  }
  const tombstones: Record<VaultPath, Tombstone> = {};
  for (const [path, ts] of Object.entries(raw.tombstones)) {
    if (path in files) throw corrupt(`path both live and tombstoned: "${path}"`);
    tombstones[validatePath(path, "tombstones")] = validateTombstone(path, ts);
  }

  const manifest: Manifest = {
    version: 1,
    generation: raw.generation,
    device: raw.device,
    updatedAt: raw.updatedAt,
    files,
    tombstones,
  };

  if (raw.history !== undefined) {
    if (!isRecord(raw.history)) throw corrupt("history is not an object");
    const history: Record<VaultPath, ManifestEntry[]> = {};
    for (const [path, versions] of Object.entries(raw.history)) {
      if (!Array.isArray(versions)) {
        throw corrupt(`history for "${path}" is not an array`);
      }
      history[validatePath(path, "history")] = versions.map((v) =>
        validateEntry(path, v),
      );
    }
    manifest.history = history;
  }
  return manifest;
}
