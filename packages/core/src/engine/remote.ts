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
  /**
   * Who published the authoritative manifest at an ARBITRARY generation —
   * the smallest deviceId there (ADR-0006 §4) — or null when that generation
   * is not in storage at all (never written, or pruned by reclamation).
   *
   * The listing that finds the top generation already sees every other one, so
   * this costs nothing. It is what lets a device ask "is the manifest at my
   * base's generation still mine?" long after the top has moved past it
   * (ADR-0040).
   */
  winnerAt: (generation: number) => DeviceId | null;
}

interface ManifestRef {
  generation: number;
  device: DeviceId;
}

/**
 * List manifests/ once and keep the winner at EVERY generation — smallest
 * deviceId, the deterministic fork rule (ADR-0006 §4).
 *
 * One entry per generation, not per object: a vault that has synced for a year
 * has thousands of generations and this is a device id each.
 */
async function listWinners(ctx: EngineContext): Promise<Map<number, DeviceId>> {
  const prefixLen = ctx.key("").length;
  const winners = new Map<number, DeviceId>();
  for await (const stat of ctx.storage.list(ctx.key(MANIFESTS_PREFIX))) {
    const ref = parseManifestKey(stat.key.slice(prefixLen));
    if (ref === null) continue; // foreign object under manifests/ — ignore
    const current = winners.get(ref.generation);
    if (current === undefined || ref.device < current) winners.set(ref.generation, ref.device);
  }
  return winners;
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
  const winners = await listWinners(ctx);
  const winnerAt = (generation: number): DeviceId | null =>
    winners.get(generation) ?? null;
  let generation = 0;
  for (const g of winners.keys()) if (g > generation) generation = g;
  const device = winners.get(generation);
  if (device === undefined) return { manifest: null, generation: 0, winnerAt };
  return {
    manifest: await fetchManifest(ctx, { generation, device }),
    generation,
    winnerAt,
  };
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
  const winners = await listWinners(ctx);
  let top = 0;
  for (const g of winners.keys()) if (g > top) top = g;
  if (
    top > manifest.generation ||
    (top === manifest.generation && winners.get(top) !== ctx.deviceId)
  ) {
    return { ok: false, reason: "lost-fork" };
  }
  return { ok: true };
}
