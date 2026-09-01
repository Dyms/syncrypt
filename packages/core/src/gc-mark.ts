// meta/gc-mark.json — serialization only (ADR-0030).
//
// Fails CLOSED like the manifest does: a mark that does not parse is treated as
// absent, which costs one more grace window and never a premature delete.

import type { GcMark } from "./reclaim.js";
import type { ObjectKey } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function serializeGcMark(mark: GcMark): Uint8Array {
  const keys = Object.keys(mark.unreachableSince).sort();
  const since: Record<ObjectKey, number> = {};
  for (const key of keys) {
    const at = mark.unreachableSince[key];
    if (at !== undefined) since[key] = at;
  }
  return encoder.encode(
    JSON.stringify({ version: 1, updatedAt: mark.updatedAt, unreachableSince: since }),
  );
}

/** Parse a mark; returns null for anything that is not exactly a valid mark. */
export function parseGcMark(bytes: Uint8Array): GcMark | null {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { version, updatedAt, unreachableSince } = raw as Record<string, unknown>;
  if (version !== 1) return null;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  if (
    typeof unreachableSince !== "object" ||
    unreachableSince === null ||
    Array.isArray(unreachableSince)
  ) {
    return null;
  }
  const since: Record<ObjectKey, number> = {};
  for (const [key, at] of Object.entries(unreachableSince)) {
    // One bad entry does not condemn the file, but it is not invented either:
    // an unparseable timestamp simply means "first seen now" on the next run.
    if (typeof at === "number" && Number.isFinite(at) && at >= 0) since[key] = at;
  }
  return { version: 1, updatedAt, unreachableSince: since };
}
