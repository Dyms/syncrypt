// The I/O half of ADR-0030: read what is in the bucket, hand it to the pure
// planner, and — only when told to — delete exactly what the planner named.

import { parseGcMark, serializeGcMark } from "../gc-mark.js";
import {
  MANIFESTS_PREFIX,
  manifestKey,
  parseManifest,
  parseManifestKey,
} from "../manifest.js";
import {
  GC_MARK_KEY,
  OBJECTS_PREFIX,
  planReclaim,
  type GcMark,
  type ManifestInStorage,
  type ReclaimPlan,
} from "../reclaim.js";
import type { ObjectKey } from "../types.js";
import type { EngineContext } from "./context.js";

/**
 * Every manifest in storage, parsed. A manifest that will not decrypt or parse
 * is FATAL here rather than skipped: treating it as absent would make
 * everything it references look unreachable, and the whole point of this file
 * is that we never delete on a guess.
 */
export async function readAllManifests(
  ctx: EngineContext,
  signal?: AbortSignal,
): Promise<ManifestInStorage[]> {
  const prefixLen = ctx.key("").length;
  const refs: { key: ObjectKey; generation: number; device: string }[] = [];
  for await (const stat of ctx.storage.list(ctx.key(MANIFESTS_PREFIX))) {
    const relative = stat.key.slice(prefixLen);
    const ref = parseManifestKey(relative);
    if (ref === null) continue; // foreign object under manifests/ — leave it alone
    refs.push({ key: relative, generation: ref.generation, device: ref.device });
  }
  const out: ManifestInStorage[] = [];
  for (const ref of refs) {
    if (signal?.aborted) return out;
    const blob = await ctx.storage.get(ctx.key(manifestKey(ref.generation, ref.device)));
    const manifest = parseManifest(await ctx.crypto.decrypt("manifest", blob));
    out.push({ key: ref.key, generation: ref.generation, manifest });
  }
  return out;
}

/** Everything under objects/, with sizes, as storage-relative keys. */
export async function listObjects(
  ctx: EngineContext,
  signal?: AbortSignal,
): Promise<{ key: ObjectKey; size: number }[]> {
  const prefixLen = ctx.key("").length;
  const out: { key: ObjectKey; size: number }[] = [];
  for await (const stat of ctx.storage.list(ctx.key(OBJECTS_PREFIX))) {
    if (signal?.aborted) return out;
    out.push({ key: stat.key.slice(prefixLen), size: stat.size });
  }
  return out;
}

/** The pending mark, or null. Unreadable is the same as absent — fail closed. */
export async function readGcMark(ctx: EngineContext): Promise<GcMark | null> {
  try {
    const blob = await ctx.storage.get(ctx.key(GC_MARK_KEY));
    return parseGcMark(await ctx.crypto.decrypt("manifest", blob));
  } catch {
    return null;
  }
}

export async function writeGcMark(ctx: EngineContext, mark: GcMark): Promise<void> {
  const blob = await ctx.crypto.encrypt("manifest", serializeGcMark(mark));
  await ctx.storage.put(ctx.key(GC_MARK_KEY), blob, { contentType: "application/json" });
}

/** Read everything the planner needs and compute the plan. Publishes nothing. */
export async function computeReclaimPlan(
  ctx: EngineContext,
  signal?: AbortSignal,
): Promise<ReclaimPlan> {
  const [manifests, objects, mark] = [
    await readAllManifests(ctx, signal),
    await listObjects(ctx, signal),
    await readGcMark(ctx),
  ];
  return planReclaim({
    now: ctx.clock.now(),
    graceSeconds: ctx.reclaimGraceSeconds,
    generationsToKeep: ctx.generationsToKeep,
    manifests,
    objects,
    mark,
  });
}
