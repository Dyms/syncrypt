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
  retainedGenerations,
  type GcMark,
  type ManifestInStorage,
  type ReclaimPlan,
} from "../reclaim.js";
import type { DeviceId, ObjectKey } from "../types.js";
import type { EngineContext } from "./context.js";

/**
 * Index every manifest in storage; fetch and parse only the RETAINED ones.
 *
 * Reachability is computed over the retained generations, so those are the only
 * manifests whose contents matter. The rest are identified by their key, which
 * is all that pruning them needs. This is not a micro-optimization: a vault
 * that has synced for a month holds thousands of generations, and one manifest
 * for a three-thousand-file vault is most of a megabyte — reading them all
 * would move gigabytes, over a mobile connection, to delete a few objects.
 *
 * A retained manifest that will not decrypt or parse is FATAL rather than
 * skipped: treating it as absent would make everything it references look
 * unreachable, and nothing here is ever deleted on a guess.
 */
export async function readManifestIndex(
  ctx: EngineContext,
  signal?: AbortSignal,
): Promise<ManifestInStorage[]> {
  const prefixLen = ctx.key("").length;
  const refs: { key: ObjectKey; generation: number; device: DeviceId }[] = [];
  for await (const stat of ctx.storage.list(ctx.key(MANIFESTS_PREFIX))) {
    const relative = stat.key.slice(prefixLen);
    const ref = parseManifestKey(relative);
    if (ref === null) continue; // foreign object under manifests/ — leave it alone
    refs.push({ key: relative, generation: ref.generation, device: ref.device });
  }
  const retained = retainedGenerations(
    refs.map((r) => r.generation),
    ctx.generationsToKeep,
  );
  const out: ManifestInStorage[] = [];
  for (const ref of refs) {
    if (signal?.aborted) return out;
    if (!retained.has(ref.generation)) {
      out.push({ key: ref.key, generation: ref.generation });
      continue;
    }
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
    await readManifestIndex(ctx, signal),
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
