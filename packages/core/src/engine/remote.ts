// Remote manifest access — ADR-0006 (immutable per-generation manifests,
// LIST-based concurrency, deterministic fork resolution).

import { SyncError } from "../errors.js";
import {
  MANIFESTS_PREFIX,
  manifestKey,
  parseManifest,
  parseManifestKey,
  serializeManifest,
} from "../manifest.js";
import type { DeviceId, Manifest } from "../types.js";
import type { EngineContext } from "./context.js";

export interface RemoteState {
  /** The authoritative remote manifest (fork already resolved), or null. */
  manifest: Manifest | null;
  /** Highest generation present in storage; 0 when no manifest exists. */
  generation: number;
}

interface ManifestRef {
  generation: number;
  device: DeviceId;
}

/** List manifests/ and return refs at the highest generation, winner first
 *  (smallest deviceId — the deterministic fork rule, ADR-0006 §4). */
async function listTop(ctx: EngineContext): Promise<ManifestRef[]> {
  const prefixLen = ctx.key("").length;
  let top: ManifestRef[] = [];
  for await (const stat of ctx.storage.list(ctx.key(MANIFESTS_PREFIX))) {
    const ref = parseManifestKey(stat.key.slice(prefixLen));
    if (ref === null) continue; // foreign object under manifests/ — ignore
    const best = top[0];
    if (best === undefined || ref.generation > best.generation) top = [ref];
    else if (ref.generation === best.generation) top.push(ref);
  }
  top.sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
  return top;
}

/** Fetch + decrypt + strictly parse one manifest. Fail-closed on corruption. */
async function fetchManifest(ctx: EngineContext, ref: ManifestRef): Promise<Manifest> {
  const blob = await ctx.storage.get(ctx.key(manifestKey(ref.generation, ref.device)));
  const bytes = await ctx.crypto.decrypt("manifest", blob);
  const manifest = parseManifest(bytes);
  if (manifest.generation !== ref.generation) {
    throw new SyncError(
      "ManifestCorrupt",
      `manifest corrupt: key generation ${ref.generation} != body generation ${manifest.generation}`,
    );
  }
  return manifest;
}

/** Authoritative remote state = LIST → highest generation → fork winner. */
export async function readRemote(ctx: EngineContext): Promise<RemoteState> {
  const top = await listTop(ctx);
  const winner = top[0];
  if (winner === undefined) return { manifest: null, generation: 0 };
  return { manifest: await fetchManifest(ctx, winner), generation: winner.generation };
}

export type PublishResult =
  | { ok: true }
  | { ok: false; reason: "precondition" | "lost-fork" };

/**
 * Publish a new generation — the commit point (ADR-0006 §3, steps 4–5).
 * The caller has already uploaded all content objects. Uses create-if-absent
 * when the provider supports it (fork prevention), then re-lists to detect a
 * fork either way. Losing a fork is not an error: no data is lost, the caller
 * reports "pull first".
 */
export async function publishManifest(
  ctx: EngineContext,
  manifest: Manifest,
): Promise<PublishResult> {
  const blob = await ctx.crypto.encrypt("manifest", serializeManifest(manifest));
  const key = ctx.key(manifestKey(manifest.generation, ctx.deviceId));
  const conditional = ctx.storage.capabilities().conditionalWrites;
  try {
    await ctx.storage.put(
      key,
      blob,
      conditional ? { ifNoneMatch: "*", contentType: "application/json" } : { contentType: "application/json" },
    );
  } catch (e) {
    if (e instanceof SyncError && e.code === "StoragePreconditionFailed") {
      return { ok: false, reason: "precondition" };
    }
    throw e;
  }

  // Re-LIST: another device may have published the same generation concurrently.
  const top = await listTop(ctx);
  const winner = top[0];
  if (
    winner !== undefined &&
    (winner.generation > manifest.generation ||
      (winner.generation === manifest.generation && winner.device !== ctx.deviceId))
  ) {
    return { ok: false, reason: "lost-fork" };
  }
  return { ok: true };
}
