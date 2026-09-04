// SyncEngine — the RFC-0007 §7 surface. Orchestrates scan → plan → apply →
// publish against the injected ports. Pure of platform APIs; all effects go
// through the ports.

import type {
  ClockPort,
  LogPort,
  StateStorePort,
  StoragePort,
  CryptoPort,
  VaultPort,
} from "../ports.js";
import { DEFAULT_PLAN_OPTIONS, plan } from "../plan.js";
import type { Operation, PlanOptions, SyncPlan } from "../plan.js";
import { SyncError } from "../errors.js";
import { parseManifest } from "../manifest.js";
import type { SyncOutcome, SyncReport, SyncReportEntry } from "../report.js";
import {
  decodeHashCache,
  detectLocalChanges,
  encodeHashCache,
  scanVault,
  type HashCache,
} from "../scan.js";
import type {
  DeviceId,
  FileDescriptor,
  Hash,
  Manifest,
  ManifestEntry,
  ObjectKey,
  VaultPath,
} from "../types.js";
import { markAfterSweep, type ReclaimPlan } from "../reclaim.js";
import { versionSkew } from "../version.js";
import { applyPullOps, applyPushOps, buildNextManifest } from "./apply.js";
import { computeReclaimPlan, listObjects, writeGcMark } from "./reclaim-io.js";
import type { EngineContext } from "./context.js";
import { publishManifest, readRemote, type RemoteState } from "./remote.js";

export interface SyncEngineConfig {
  storage: StoragePort;
  vault: VaultPort;
  crypto: CryptoPort;
  clock?: ClockPort;
  log?: LogPort;
  state?: StateStorePort; // base-manifest persistence (ADR-0011)
  deviceId: DeviceId;
  storagePrefix: string; // bucket key prefix for this vault
  /**
   * This client's version, e.g. the plugin's manifest version (ADR-0036).
   * Recorded in every manifest it publishes, and compared against what it
   * reads so a vault shared by mismatched devices says so instead of behaving
   * differently on each of them. Optional: an engine without one records
   * nothing and warns about nothing.
   */
  clientVersion?: string;
  safeSync?: Partial<PlanOptions> & {
    versionsToKeep?: number;
    /** Tombstone expiry window in seconds; 0 disables it (ADR-0031). */
    tombstoneGraceSeconds?: number;
    /** How long an object must sit unreachable before a sweep (ADR-0030). */
    reclaimGraceSeconds?: number;
    /** Manifest generations retained (ADR-0030). */
    generationsToKeep?: number;
  };
  network?: {
    // resource-aware auto-sync (RFC-0004); consumed by clients, not the engine
    wifiOnly?: boolean;
    minAutoSyncIntervalSec?: number;
    debounceSec?: number;
  };
}

export interface SyncStatus {
  baseGeneration: number | null;
  dirtyFiles: number;
  lastReport?: SyncReport;
  locked: boolean; // is a sync in progress
  /**
   * Stored copies kept for forgotten entries (ADR-0055). Read from the base,
   * so it costs nothing — and it is the only way a client can tell the user
   * why reclaiming freed less than they expected.
   */
  forgottenObjects: number;
}

export interface SyncEngine {
  /** Download remote changes; apply deletions via trash; surface conflicts. */
  pull(signal?: AbortSignal): Promise<SyncReport>;

  /** Upload local changes; publish a new generation (ADR-0006). */
  push(signal?: AbortSignal): Promise<SyncReport>;

  /** pull() then push(). The default user action. */
  sync(signal?: AbortSignal): Promise<SyncReport>;

  /** Compute and return the plan WITHOUT touching any file or object (FR-14). */
  dryRun(signal?: AbortSignal): Promise<SyncPlan>;

  /** Re-run a plan that returned requiresConfirmation, now approved by the user. */
  confirmAndApply(plan: SyncPlan, signal?: AbortSignal): Promise<SyncReport>;

  /** Current state: base generation, dirty files, last report — no I/O beyond a scan. */
  status(): Promise<SyncStatus>;

  /**
   * Cheap proof that the configured storage AND the derived keys actually open
   * this vault: read the published manifest and decrypt it. No local scan, no
   * writes. Returns null when the vault has no manifest yet (a fresh vault —
   * any passphrase is valid, it will create one on the first push).
   *
   * Fails closed exactly like a sync would: CryptoAuthError for a wrong
   * passphrase or tampered data, Storage* errors for an unreachable bucket.
   * Clients use it to report a wrong passphrase at UNLOCK time instead of
   * halfway through the first sync (RFC-0007 §7).
   */
  verifyAccess(signal?: AbortSignal): Promise<{ generation: number; files: number } | null>;

  /**
   * Forget every remembered content hash, in memory and on disk (ADR-0023).
   *
   * The cache keys a hash by (size, mtime), which a writer that PRESERVES both
   * can defeat — `rsync --times`, a restic/borg restore, another sync tool
   * putting an old copy back byte-for-byte the same length. Within a session
   * that was always true and self-corrected on restart; persisted, it does
   * not. This is the escape hatch: the next scan re-reads and re-hashes
   * everything.
   *
   * Costs time, never correctness — it can only turn a wrong answer into a
   * recomputed one. The base manifest is untouched, so this is NOT a reset.
   */
  forgetHashCache(): Promise<void>;

  /**
   * Forget the base manifest — this device's record of what it last synced
   * against (ADR-0038).
   *
   * The escape hatch for a storage that went backwards on purpose: a bucket
   * restored from a backup, or manifests removed by hand. A lower generation
   * is indistinguishable from an attack, so every sync refuses until someone
   * says which of the two it was; this is how they say it.
   *
   * Dropping the base costs safety, not data. With no base, `plan()` cannot
   * tell "the other side deleted it" from "I never had it", so it deletes
   * nothing and every file that differs on both sides comes back as a conflict
   * with both versions kept (RFC-0004). The hash cache is untouched, so the
   * next scan is no slower than usual.
   */
  forgetBase(): Promise<void>;

  /**
   * Manifest entries this device does NOT carry (ADR-0027).
   *
   * Candidates for review, never a verdict: a device cannot see other devices'
   * profiles, so "not mine" is all it can honestly say. Everything outside this
   * device's profile is listed — including files that are perfectly alive on
   * another machine — with the size and date needed to recognize them. Reading
   * only; nothing is published.
   */
  listUncarried(signal?: AbortSignal): Promise<UncarriedEntry[]>;

  /**
   * Drop these paths from the manifest WITHOUT tombstoning them (ADR-0027).
   *
   * Not a deletion: no tombstone is written and no file is touched anywhere.
   * A device that still carries such a path re-adds it on its next push
   * (RFC-0004 treats "in my base, gone from the manifest" as an anomaly to
   * repair, never as a deletion to propagate). So the worst outcome of a wrong
   * guess is that the entry comes back a generation later.
   */
  forgetPaths(paths: VaultPath[], signal?: AbortSignal): Promise<ForgetResult>;

  /**
   * Let go of the objects kept for forgotten entries (ADR-0055).
   *
   * Forgetting an entry keeps its ciphertext reachable, because the judgement
   * behind it — "no device carries this any more" — is one the user makes
   * without being able to see the other devices. This is the second half, said
   * out loud: after it, those objects are ordinary garbage and the next
   * reclamation deletes them, grace window and re-check and all.
   *
   * Publishes a generation and nothing else; deleting is still reclamation's
   * job, so this is undoable right up until that runs.
   */
  releaseForgotten(signal?: AbortSignal): Promise<ReleaseResult>;

  /**
   * What reclaiming storage would delete, WITHOUT deleting anything (ADR-0030).
   *
   * Reads every manifest and lists every object, computes reachability over the
   * retained generations, and reports three numbers: what is deletable now,
   * what is still waiting out its grace window, and which manifest generations
   * would be pruned. Publishes nothing and marks nothing.
   */
  previewReclaim(signal?: AbortSignal): Promise<ReclaimPlan>;

  /**
   * Reclaim storage: prune manifest generations below the retention cut, delete
   * the objects that have been unreachable for longer than the grace window,
   * and record the rest so they can go on a later run (ADR-0030).
   *
   * The one operation nothing undoes. It never touches anything outside
   * `objects/` and never deletes an object that any retained manifest still
   * references — re-checked at the moment of deletion, which is what makes the
   * deduplication probe in `applyPushOps` safe against it.
   */
  reclaimStorage(signal?: AbortSignal): Promise<ReclaimResult>;
}

export interface ReclaimResult {
  /** Object keys actually deleted. */
  deleted: ObjectKey[];
  /** Bytes those objects occupied, as storage reported them. */
  bytesFreed: number;
  /** Manifest objects pruned by the generation-retention rule. */
  prunedManifests: number;
  /** Unreachable objects now waiting out the grace window. */
  waiting: number;
  /** When the oldest of them ripens (epoch seconds); null when none wait. */
  ripeAt: number | null;
}

/** One manifest entry this device does not carry — enough to recognize it. */
export interface UncarriedEntry {
  path: VaultPath;
  size: number;
  /** Epoch seconds, as recorded by whichever device last published it. */
  mtime: number;
  hash: Hash;
}

export interface ForgetResult {
  /** Paths actually removed (a path already absent is silently skipped). */
  forgotten: VaultPath[];
  /** The generation published, or null when there was nothing to do. */
  generation: number | null;
}

export interface ReleaseResult {
  /** How many object keys stopped being kept. */
  released: number;
  /** The generation published, or null when there was nothing to do. */
  generation: number | null;
}

/** RFC-0004 §Deletion & tombstone GC — 30 days, resolved by ADR-0031. */
export const DEFAULT_TOMBSTONE_GRACE_SECONDS = 30 * 24 * 60 * 60;
/** Long enough that no single push can outlive it; short enough to be usable. */
export const DEFAULT_RECLAIM_GRACE_SECONDS = 24 * 60 * 60;
/** Manifest generations kept for point-in-time recovery (ADR-0030). */
export const DEFAULT_GENERATIONS_TO_KEEP = 10;

const noopLog: LogPort = {
  entry: () => undefined,
  notice: () => undefined,
};

const systemClock: ClockPort = {
  now: () => Math.floor(Date.now() / 1000),
};

/** A destructive op destroys or replaces existing bytes somewhere (ADR-0010). */
function destructiveKey(op: Operation): string | null {
  if (op.kind === "delete-local" || op.kind === "delete-remote") {
    return `${op.kind} ${op.path}`;
  }
  if (op.kind === "download" && op.localHash !== undefined) {
    return `overwrite ${op.path}`;
  }
  return null;
}

const isPushOp = (op: Operation): boolean =>
  op.kind === "upload" || op.kind === "delete-remote";

class Engine implements SyncEngine {
  private readonly ctx: EngineContext;
  private readonly statePort: StateStorePort | undefined;
  private base: Manifest | null = null;
  private readonly cache: HashCache = new Map();
  private lastReport: SyncReport | undefined;
  /** Last blob handed to the state port, to skip writing the same bytes twice. */
  private lastSavedState: string | undefined;
  private stateLoaded = false;
  /** One version-skew line per session, not one per sync. */
  private versionSkewReported = false;
  private running = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(config: SyncEngineConfig) {
    const prefix = config.storagePrefix.replace(/\/+$/, "");
    this.statePort = config.state;
    this.ctx = {
      storage: config.storage,
      vault: config.vault,
      crypto: config.crypto,
      clock: config.clock ?? systemClock,
      log: config.log ?? noopLog,
      deviceId: config.deviceId,
      key: (relative: ObjectKey): ObjectKey =>
        prefix === "" ? relative : `${prefix}/${relative}`,
      hashCache: this.cache,
      planOptions: {
        // The vault's own profile decides what this device carries (ADR-0022).
        ...(config.vault.syncable !== undefined
          ? { syncable: (path: VaultPath): boolean => config.vault.syncable?.(path) ?? true }
          : {}),
        bulkChangeFloor:
          config.safeSync?.bulkChangeFloor ?? DEFAULT_PLAN_OPTIONS.bulkChangeFloor,
        bulkChangeMaxFiles:
          config.safeSync?.bulkChangeMaxFiles ?? DEFAULT_PLAN_OPTIONS.bulkChangeMaxFiles,
        bulkChangeMaxFraction:
          config.safeSync?.bulkChangeMaxFraction ??
          DEFAULT_PLAN_OPTIONS.bulkChangeMaxFraction,
        deletionBurstWindow:
          config.safeSync?.deletionBurstWindow ?? DEFAULT_PLAN_OPTIONS.deletionBurstWindow,
      },
      versionsToKeep: config.safeSync?.versionsToKeep ?? 3,
      ...(config.clientVersion !== undefined ? { clientVersion: config.clientVersion } : {}),
      tombstoneGraceSeconds:
        config.safeSync?.tombstoneGraceSeconds ?? DEFAULT_TOMBSTONE_GRACE_SECONDS,
      reclaimGraceSeconds:
        config.safeSync?.reclaimGraceSeconds ?? DEFAULT_RECLAIM_GRACE_SECONDS,
      generationsToKeep: config.safeSync?.generationsToKeep ?? DEFAULT_GENERATIONS_TO_KEEP,
    };
  }

  // -- concurrency: one sync at a time; callers queue up ---------------------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.running = true;
      try {
        return await fn();
      } finally {
        this.running = false;
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // -- device-local state (ADR-0011): a cache, never a source of truth -------

  /**
   * Adopt a manifest as THIS DEVICE's base, keeping only the paths it carries
   * (ADR-0025).
   *
   * The base means "what this device last synced against". A published
   * manifest describes the whole vault, including files this device's profile
   * does not cover — it never had them and never will while that profile
   * stands. Recording them anyway makes the base claim a local state that was
   * never true, and the moment the profile WIDENS to include such a path, the
   * planner reads "in base, absent locally" as a deletion and tombstones it
   * for every device. ADR-0022 stopped that happening at a constant profile;
   * this stops it happening when the profile changes — which the shared
   * config-sync profile (ADR-0024) makes an ordinary event.
   *
   * Tombstones and history are kept as they are: they carry no claim about
   * what this device holds.
   */
  private adoptBase(manifest: Manifest): void {
    const syncable = this.ctx.planOptions.syncable;
    if (syncable === undefined) {
      this.base = manifest;
      return;
    }
    const files: Record<VaultPath, ManifestEntry> = {};
    for (const [path, entry] of Object.entries(manifest.files)) {
      if (syncable(path)) files[path] = entry;
    }
    this.base = { ...manifest, files };
  }

  private async loadStateOnce(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    if (this.statePort === undefined) return;
    let raw: unknown;
    try {
      const blob = await this.statePort.load();
      if (blob === null) return;
      raw = JSON.parse(new TextDecoder().decode(blob));
      if (typeof raw !== "object" || raw === null) return;
      const baseRaw = (raw as { base?: unknown }).base;
      if (baseRaw !== undefined && baseRaw !== null) {
        // Filtered on the way in too: state written before ADR-0025, or under
        // a wider profile, must not resurrect the defect on this run.
        this.adoptBase(parseManifest(new TextEncoder().encode(JSON.stringify(baseRaw))));
      }
    } catch (e) {
      // Corrupt state is discarded: base=null forces a safe full reconcile.
      this.ctx.log.notice({ code: "state-unreadable", detail: String(e) });
      this.base = null;
      return;
    }
    // The hash cache rides in the same blob (ADR-0023). It is restored on a
    // best-effort basis and can never invalidate the base above: state written
    // by version 1 carries none, and the next scan rebuilds whatever is missing.
    for (const [path, entry] of decodeHashCache((raw as { hashes?: unknown }).hashes)) {
      this.cache.set(path, entry);
    }
  }

  private async saveState(): Promise<void> {
    if (this.statePort === undefined) return;
    const serialized = JSON.stringify({
      version: 2,
      base: this.base,
      hashes: encodeHashCache(this.cache, this.ctx.clock.now()),
    });
    // A quiet sync produces byte-identical state. Rewriting it would put a
    // vault-sized file through the adapter every few minutes for nothing —
    // most visible on mobile, where this blob is the largest thing we write.
    if (serialized === this.lastSavedState) return;
    await this.statePort.save(new TextEncoder().encode(serialized));
    this.lastSavedState = serialized;
  }

  forgetHashCache(): Promise<void> {
    // Queued like any other operation: dropping the cache under a running scan
    // would have it re-populated from the scan it was meant to invalidate.
    return this.exclusive(async () => {
      this.cache.clear();
      await this.saveState();
    });
  }

  forgetBase(): Promise<void> {
    // Queued for the same reason as the cache: a sync holding the old base in
    // a local would publish it back a moment later.
    return this.exclusive(async () => {
      await this.loadStateOnce();
      this.base = null;
      await this.saveState();
    });
  }

  listUncarried(signal?: AbortSignal): Promise<UncarriedEntry[]> {
    return this.exclusive(async () => {
      await this.loadStateOnce();
      const remote = await readRemote(this.ctx);
      // Candidates computed from a manifest we have already refused would
      // invite the user to act on it (ADR-0038, ADR-0041).
      if (remote.manifest === null || this.rolledBack(remote)) return [];
      if (signal?.aborted) return [];
      const carried = this.ctx.planOptions.syncable ?? ((): boolean => true);
      const out: UncarriedEntry[] = [];
      for (const [path, entry] of Object.entries(remote.manifest.files)) {
        if (carried(path)) continue;
        out.push({ path, size: entry.size, mtime: entry.mtime, hash: entry.hash });
      }
      out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return out;
    });
  }

  forgetPaths(paths: VaultPath[], signal?: AbortSignal): Promise<ForgetResult> {
    return this.exclusive(async () => {
      await this.loadStateOnce();
      const wanted = new Set(paths);
      const remote = await readRemote(this.ctx);
      // Publishing here would write generation N+1 on top of a storage that
      // has gone backwards — reusing a generation number that already held
      // different content — and, by lowering our own base, silently clear the
      // ADR-0038 refusal without anyone confirming anything (ADR-0041).
      if (remote.manifest === null || wanted.size === 0 || this.rolledBack(remote)) {
        return { forgotten: [], generation: null };
      }
      const forgotten = Object.keys(remote.manifest.files).filter((p) => wanted.has(p));
      if (forgotten.length === 0 || signal?.aborted) {
        return { forgotten: [], generation: null };
      }

      const files = { ...remote.manifest.files };
      const history = { ...(remote.manifest.history ?? {}) };
      // The ciphertext of a forgotten path is not garbage. ADR-0027 called
      // this operation non-destructive on the grounds that a device still
      // carrying the path re-adds it — true, and it says nothing about a path
      // NO device carries, which is exactly what this command is pointed at.
      // Once ADR-0030 could delete unreferenced objects, forgetting became a
      // delete button for the one case where storage held the only copy. The
      // keys move here instead; releasing them is its own act (ADR-0055).
      const kept = new Set<ObjectKey>(remote.manifest.forgotten ?? []);
      for (const path of forgotten) {
        const entry = files[path];
        if (entry !== undefined) kept.add(entry.objectKey);
        // Retained versions go with the entry — and so do their objects.
        for (const version of history[path] ?? []) kept.add(version.objectKey);
        delete files[path];
        delete history[path];
      }
      const generation = remote.generation + 1;
      const next: Manifest = {
        version: 1,
        generation,
        device: this.ctx.deviceId,
        updatedAt: this.ctx.clock.now(),
        files,
        // Deliberately NOT tombstoned: this is forgetting, not deleting.
        tombstones: { ...remote.manifest.tombstones },
      };
      if (Object.keys(history).length > 0) next.history = history;
      if (kept.size > 0) next.forgotten = [...kept].sort();
      // ADR-0036: this manifest is published by us, so it says so. Building it
      // by hand here used to skip that, and every peer then reported the vault
      // as written by a client older than itself.
      if (this.ctx.clientVersion !== undefined) next.writer = this.ctx.clientVersion;

      const published = await publishManifest(this.ctx, next);
      if (!published.ok) {
        // Someone else moved first; the caller re-lists and tries again.
        return { forgotten: [], generation: null };
      }
      this.adoptBase(next);
      await this.saveState();
      this.ctx.log.notice({
        code: "manifest-entries-forgotten",
        count: forgotten.length,
        generation,
      });
      return { forgotten, generation };
    });
  }

  releaseForgotten(signal?: AbortSignal): Promise<ReleaseResult> {
    return this.exclusive(async () => {
      await this.loadStateOnce();
      const remote = await readRemote(this.ctx);
      // Same three doors as forgetPaths: nothing to act on, a storage that
      // went backwards (ADR-0041), or a cancelled run.
      if (remote.manifest === null || this.rolledBack(remote) || signal?.aborted) {
        return { released: 0, generation: null };
      }
      const released = remote.manifest.forgotten?.length ?? 0;
      if (released === 0) return { released: 0, generation: null };

      const generation = remote.generation + 1;
      const next: Manifest = {
        version: 1,
        generation,
        device: this.ctx.deviceId,
        updatedAt: this.ctx.clock.now(),
        files: { ...remote.manifest.files },
        tombstones: { ...remote.manifest.tombstones },
      };
      if (remote.manifest.history !== undefined) {
        next.history = { ...remote.manifest.history };
      }
      // `forgotten` deliberately absent: that IS the release.
      if (this.ctx.clientVersion !== undefined) next.writer = this.ctx.clientVersion;

      const published = await publishManifest(this.ctx, next);
      if (!published.ok) return { released: 0, generation: null };
      this.adoptBase(next);
      await this.saveState();
      this.ctx.log.notice({ code: "forgotten-objects-released", count: released, generation });
      return { released, generation };
    });
  }

  /**
   * The base to plan against — null when ours lost a fork (ADR-0035).
   *
   * `publishManifest` re-LISTs after its own write, so it detects a fork that
   * already exists at that instant. It CANNOT detect one created afterwards:
   * if we publish generation G and the eventual winner publishes G a moment
   * later, our re-LIST saw only us, we reported success, and we adopted our
   * own manifest as base. Nothing has told us since.
   *
   * From then on our base is a manifest that no device will ever read again,
   * and it is the one thing the planner trusts as the common ancestor. It says
   * "local == base" for our own change, so the winner's version of the same
   * file classifies as `download` — a silent overwrite of our edit, which is
   * the one thing RFC-0004 promises never happens.
   *
   * Detecting it is cheap: at a given generation there is exactly one
   * authoritative manifest (the smallest deviceId, ADR-0006 §4). If the
   * authoritative manifest at OUR base's generation was published by somebody
   * else, our base is not it. There is no honest ancestor to fall back on — we
   * overwrote it when we adopted our own — so we plan without one. Identical
   * files still classify as no-ops; genuinely divergent ones become conflicts
   * and both versions are kept, which is what ADR-0006 §4 promised all along.
   */
  /**
   * Say once per session when this vault is shared by mismatched clients
   * (ADR-0036).
   *
   * It can only ever warn the CURRENT client: an older one does not have this
   * code and cannot be taught anything by us. That asymmetry is the whole
   * design — the useful direction is telling a person which of their devices
   * is the stale one, not stopping a device that is already misbehaving.
   */
  private noteVersionSkew(remote: Manifest | null): void {
    if (remote === null || this.versionSkewReported) return;
    const self = this.ctx.clientVersion;
    if (self === undefined) return;
    const skew = versionSkew(remote.writer, self);
    if (skew === "same" || skew === "unknown") return;
    this.versionSkewReported = true;
    this.ctx.log.notice(
      skew === "client-behind"
        ? { code: "vault-written-by-newer", writer: remote.writer ?? "", self }
        : { code: "vault-written-by-older", ...(remote.writer !== undefined ? { writer: remote.writer } : { writer: undefined }), self },
    );
  }

  /**
   * Has the storage gone BACKWARDS since we last read it (ADR-0038)?
   *
   * Generations only ever increase (ADR-0006), so a highest-generation lower
   * than the one we already have means manifests were removed. Deleting the
   * newest one is enough: the previous generation becomes authoritative, every
   * file it describes classifies as "remote is newer", and the vault is
   * quietly restored to an earlier state. Everything decrypts perfectly — it
   * is not tampering, so nothing fails closed on its own.
   *
   * Refused per sync rather than latched: a backend whose LIST briefly misses
   * the newest object recovers by itself on the next attempt, while a storage
   * that really did lose generations keeps refusing until a person decides
   * what to do about it.
   */
  private rolledBack(remote: RemoteState): boolean {
    const base = this.base;
    if (base === null || remote.generation >= base.generation) return false;
    this.ctx.log.notice({
      code: "storage-rolled-back",
      remote: remote.generation,
      base: base.generation,
    });
    return true;
  }

  private baseFor(remote: RemoteState): Manifest | null {
    const base = this.base;
    if (base === null || remote.manifest === null) return base;
    // The winner AT OUR GENERATION, which is the question. Asking it only of
    // the top generation (what shipped in beta.10) made the repair expire the
    // moment the winner published anything else — one more push and the
    // silent overwrite was back (ADR-0040).
    const winner = remote.winnerAt(base.generation);
    // Not in storage any more: pruned by reclamation, or a base this device
    // never published. Nothing to compare against, so nothing to claim.
    if (winner === null || winner === base.device) return base;
    this.ctx.log.notice({ code: "fork-lost", generation: base.generation });
    return null;
  }

  // -- storage reclamation (ADR-0030) -----------------------------------------

  previewReclaim(signal?: AbortSignal): Promise<ReclaimPlan> {
    return this.exclusive(async () => {
      await this.loadStateOnce();
      const plan = await computeReclaimPlan(this.ctx, signal);
      this.refuseReclaimOnRollback(plan, signal);
      return plan;
    });
  }

  /**
   * Reclaiming a storage that has gone backwards makes the rollback permanent
   * (ADR-0041). The objects that only the deleted generations referenced are
   * exactly the ones a restore from bucket versioning — the threat model's
   * first recommendation — would need. `pull` and `push` already refuse; this
   * is the third door into the same bucket and it was left open.
   */
  private refuseReclaimOnRollback(plan: ReclaimPlan, signal?: AbortSignal): void {
    const base = this.base;
    // A cancelled run stopped listing early, so its plan reports whatever it
    // had seen — generation 0 if it stopped immediately. That is not a
    // rollback, and saying so would put a frightening line in the log for
    // someone who simply pressed cancel.
    if (signal?.aborted === true) return;
    if (base === null || plan.generation >= base.generation) return;
    this.ctx.log.notice({
      code: "storage-rolled-back",
      remote: plan.generation,
      base: base.generation,
    });
    throw new SyncError(
      "ManifestCorrupt",
      `refusing to reclaim: storage is at generation ${String(plan.generation)}, this device synced against ${String(base.generation)}`,
    );
  }

  reclaimStorage(signal?: AbortSignal): Promise<ReclaimResult> {
    return this.exclusive(async () => {
      // Recomputed here, not taken from the caller's preview: between a
      // preview and a click another device can publish a generation that
      // adopts one of these objects (the dedup probe in applyPushOps). The
      // re-check IS the safety property — never sweep a stale plan.
      await this.loadStateOnce();
      const plan = await computeReclaimPlan(this.ctx, signal);
      this.refuseReclaimOnRollback(plan, signal);
      const deleted: ObjectKey[] = [];
      let bytesFreed = 0;
      const sizes = new Map(
        (await listObjects(this.ctx, signal)).map((o) => [o.key, o.size] as const),
      );

      for (const key of plan.sweep) {
        if (signal?.aborted) break;
        await this.ctx.storage.delete(this.ctx.key(key));
        deleted.push(key);
        bytesFreed += sizes.get(key) ?? 0;
      }

      let prunedManifests = 0;
      for (const key of plan.prunedManifests) {
        if (signal?.aborted) break;
        await this.ctx.storage.delete(this.ctx.key(key));
        prunedManifests++;
      }

      // Persist what is still waiting so the next run does not restart their
      // clocks. A failure here costs one more grace window, never a file.
      //
      // NOT written when the run was cancelled: the plan behind it was
      // computed from a listing that stopped early, so persisting it would
      // reset the grace clocks of objects nobody looked at (ADR-0045).
      if (signal?.aborted !== true) {
        await writeGcMark(this.ctx, markAfterSweep(plan, deleted)).catch(() => undefined);
      }

      this.ctx.log.notice({
        code: "storage-reclaimed",
        deleted: deleted.length,
        bytesFreed,
        prunedManifests,
        waiting: plan.waiting,
      });
      return {
        deleted,
        bytesFreed,
        prunedManifests,
        waiting: plan.waiting,
        ripeAt: plan.ripeAt,
      };
    });
  }

  // -- reports ----------------------------------------------------------------

  private report(
    startedAt: number,
    outcome: SyncOutcome,
    entries: SyncReportEntry[],
    fromGeneration: number | null,
    toGeneration: number | null,
    conflicts: VaultPath[] = [],
  ): SyncReport {
    const r: SyncReport = {
      startedAt,
      finishedAt: this.ctx.clock.now(),
      entries,
      fromGeneration,
      toGeneration,
      outcome,
      conflicts,
    };
    for (const e of entries) this.ctx.log.entry(e);
    if (outcome !== "applied" && outcome !== "no-op") {
      this.ctx.log.notice({ code: "sync-outcome", outcome });
    }
    this.lastReport = r;
    return r;
  }

  // -- RFC-0007 §7 surface ----------------------------------------------------

  pull(signal?: AbortSignal): Promise<SyncReport> {
    return this.exclusive(() => this.doPull(signal));
  }

  /**
   * Scan, and hand back the plan options this scan is valid under.
   *
   * A path two local files canonicalize to cannot go in the manifest, which
   * has room for one of them (ADR-0053). It must also not be read as ABSENT:
   * that is a local deletion, and it would tombstone the entry for every
   * other device. Excluding it is exactly what `syncable` already means —
   * "not this device's business" — so the same door is used.
   */
  private async scanLocal(
    signal?: AbortSignal,
  ): Promise<{ local: FileDescriptor[]; planOptions: PlanOptions }> {
    const ambiguous = new Set<VaultPath>();
    const local = await scanVault(
      this.ctx.vault,
      this.ctx.crypto,
      this.cache,
      signal,
      ambiguous,
    );
    if (ambiguous.size === 0) return { local, planOptions: this.ctx.planOptions };
    this.ctx.log.notice({ code: "paths-not-distinct", paths: [...ambiguous].sort() });
    const carried = this.ctx.planOptions.syncable ?? ((): boolean => true);
    return {
      local,
      planOptions: {
        ...this.ctx.planOptions,
        syncable: (path: VaultPath): boolean => !ambiguous.has(path) && carried(path),
      },
    };
  }

  private async doPull(signal?: AbortSignal): Promise<SyncReport> {
    const startedAt = this.ctx.clock.now();
    await this.loadStateOnce();
    const fromGen = this.base?.generation ?? null;
    const remote = await readRemote(this.ctx);
    const { local, planOptions } = await this.scanLocal(signal);
    if (signal?.aborted) {
      // A partial scan must never be mistaken for mass deletion.
      return this.report(startedAt, "aborted", [], fromGen, fromGen);
    }
    if (this.rolledBack(remote)) {
      return this.report(startedAt, "rolled-back", [], fromGen, fromGen);
    }
    this.noteVersionSkew(remote.manifest);
    const p = plan(local, this.baseFor(remote), remote.manifest, planOptions);

    if (p.requiresConfirmation) {
      // Invariant §8.7: never auto-apply; the caller must confirmAndApply.
      this.ctx.log.notice({
        code: "confirmation-required",
        ...(p.confirmationReason !== undefined ? { reason: p.confirmationReason } : {}),
      });
      return this.report(startedAt, "needs-confirmation", [], fromGen, fromGen);
    }
    if (p.pacingDiscount !== undefined) {
      // The breaker stayed quiet on a change that would once have stopped it
      // (ADR-0029) — the user should hear that, not just find fewer files.
      this.ctx.log.notice({ code: "deletions-paced", discount: p.pacingDiscount });
    }
    if (remote.manifest === null) {
      return this.report(startedAt, "no-op", [], fromGen, fromGen);
    }

    const res = await applyPullOps(this.ctx, p.operations, remote.manifest, signal);
    if (!res.aborted) {
      // The base advances to what we synced against — including conflict paths
      // (their local resolution is carried forward by the next push, ADR-0012).
      this.adoptBase(remote.manifest);
      await this.saveState();
    }
    const outcome: SyncOutcome = res.aborted
      ? "aborted"
      : res.conflicts.length > 0
        ? "conflicts"
        : res.entries.length > 0
          ? "applied"
          : "no-op";
    return this.report(
      startedAt,
      outcome,
      res.entries,
      fromGen,
      res.aborted ? fromGen : remote.generation,
      res.conflicts,
    );
  }

  push(signal?: AbortSignal): Promise<SyncReport> {
    return this.exclusive(() => this.doPush(signal));
  }

  private async doPush(signal?: AbortSignal): Promise<SyncReport> {
    const startedAt = this.ctx.clock.now();
    await this.loadStateOnce();
    const fromGen = this.base?.generation ?? null;
    const remote = await readRemote(this.ctx);
    const { local, planOptions } = await this.scanLocal(signal);
    if (signal?.aborted) {
      // A partial scan must never be mistaken for mass deletion.
      return this.report(startedAt, "aborted", [], fromGen, fromGen);
    }
    if (this.rolledBack(remote)) {
      return this.report(startedAt, "rolled-back", [], fromGen, fromGen);
    }
    this.noteVersionSkew(remote.manifest);
    const p = plan(local, this.baseFor(remote), remote.manifest, planOptions);

    if (p.pullFirst) {
      // ADR-0002 / RFC-0002 FR-8: someone published since our last pull.
      this.ctx.log.notice({ code: "pull-first" });
      return this.report(startedAt, "pull-first", [], fromGen, fromGen);
    }
    if (p.requiresConfirmation) {
      this.ctx.log.notice({
        code: "confirmation-required",
        ...(p.confirmationReason !== undefined ? { reason: p.confirmationReason } : {}),
      });
      return this.report(startedAt, "needs-confirmation", [], fromGen, fromGen);
    }
    if (p.pacingDiscount !== undefined) {
      this.ctx.log.notice({ code: "deletions-paced", discount: p.pacingDiscount });
    }
    if (p.summary.conflicts > 0) {
      // Possible only after losing a manifest fork (ADR-0006 §4): a pull will
      // materialize these per ADR-0012.
      const conflicts = p.operations
        .filter((o) => o.kind === "conflict")
        .map((o) => o.path);
      return this.report(startedAt, "conflicts", [], fromGen, fromGen, conflicts);
    }

    const pushOps = p.operations.filter(isPushOp);
    if (pushOps.length === 0) {
      return this.report(startedAt, "no-op", [], fromGen, fromGen);
    }

    const res = await applyPushOps(this.ctx, pushOps, local, signal);
    if (res.aborted) {
      // Objects may exist in storage but the manifest did not advance —
      // harmless orphans; the next push completes idempotently (RFC-0004).
      return this.report(startedAt, "aborted", res.entries, fromGen, fromGen);
    }

    const generation = remote.generation + 1;
    const next = buildNextManifest(
      this.ctx,
      remote.manifest,
      generation,
      res.uploaded,
      res.tombstoned,
    );
    const published = await publishManifest(this.ctx, next);
    if (!published.ok) {
      // Lost the race or the fork. Our objects are harmless; nothing committed.
      this.ctx.log.notice({ code: "pull-first" });
      return this.report(startedAt, "pull-first", [], fromGen, fromGen);
    }

    this.adoptBase(next);
    await this.saveState();
    return this.report(startedAt, "applied", res.entries, fromGen, generation);
  }

  async sync(signal?: AbortSignal): Promise<SyncReport> {
    const pullReport = await this.pull(signal);
    if (
      pullReport.outcome !== "applied" &&
      pullReport.outcome !== "no-op" &&
      pullReport.outcome !== "conflicts"
    ) {
      return pullReport;
    }
    const pushReport = await this.push(signal);
    const conflicts = [...new Set([...pullReport.conflicts, ...pushReport.conflicts])];
    const entries = [...pullReport.entries, ...pushReport.entries];
    let outcome: SyncOutcome = pushReport.outcome;
    if (outcome === "applied" || outcome === "no-op") {
      if (conflicts.length > 0) outcome = "conflicts";
      else if (entries.length > 0) outcome = "applied";
    }
    const merged: SyncReport = {
      startedAt: pullReport.startedAt,
      finishedAt: pushReport.finishedAt,
      entries,
      fromGeneration: pullReport.fromGeneration,
      toGeneration: pushReport.toGeneration ?? pullReport.toGeneration,
      outcome,
      conflicts,
    };
    this.lastReport = merged;
    return merged;
  }

  // Read-only, and deliberately NOT guarded against a rolled-back storage
  // (ADR-0038): a plan applies nothing by itself, and the confirmAndApply it
  // feeds refuses. Showing what the rolled-back storage would do is, if
  // anything, the clearest evidence of what happened to it.
  dryRun(signal?: AbortSignal): Promise<SyncPlan> {
    return this.exclusive(async () => {
      await this.loadStateOnce();
      const remote = await readRemote(this.ctx);
      const { local, planOptions } = await this.scanLocal(signal);
      return plan(local, this.baseFor(remote), remote.manifest, planOptions);
    });
  }

  confirmAndApply(confirmed: SyncPlan, signal?: AbortSignal): Promise<SyncReport> {
    return this.exclusive(() => this.doConfirmAndApply(confirmed, signal));
  }

  private async doConfirmAndApply(
    confirmed: SyncPlan,
    signal?: AbortSignal,
  ): Promise<SyncReport> {
    const startedAt = this.ctx.clock.now();
    await this.loadStateOnce();
    const fromGen = this.base?.generation ?? null;

    // Re-plan against FRESH remote state: the world may have moved since the
    // user saw the plan. Anything destructive that was not in the confirmed
    // plan must NOT be applied on the strength of that confirmation.
    const remote = await readRemote(this.ctx);
    const { local, planOptions } = await this.scanLocal(signal);
    if (signal?.aborted) {
      return this.report(startedAt, "aborted", [], fromGen, fromGen);
    }
    // A confirmation is consent to the plan the user SAW. It is not consent to
    // a storage that lost generations in the meantime (ADR-0038).
    if (this.rolledBack(remote)) {
      return this.report(startedAt, "rolled-back", [], fromGen, fromGen);
    }
    const fresh = plan(local, this.baseFor(remote), remote.manifest, planOptions);
    const confirmedDestructive = new Set(
      confirmed.operations.map(destructiveKey).filter((k) => k !== null),
    );
    const unconfirmed = fresh.operations.filter((op) => {
      const k = destructiveKey(op);
      return k !== null && !confirmedDestructive.has(k);
    });
    if (unconfirmed.length > 0) {
      this.ctx.log.notice({
        code: "confirmation-stale",
        newDestructive: unconfirmed.length,
      });
      return this.report(startedAt, "needs-confirmation", [], fromGen, fromGen);
    }

    return this.applyFull(startedAt, fresh, remote, local, signal);
  }

  /** Apply pull side, then push side + publish — used by confirmAndApply. */
  private async applyFull(
    startedAt: number,
    p: SyncPlan,
    remote: RemoteState,
    local: Awaited<ReturnType<typeof scanVault>>,
    signal?: AbortSignal,
  ): Promise<SyncReport> {
    const fromGen = this.base?.generation ?? null;
    let entries: SyncReportEntry[] = [];
    let conflicts: VaultPath[] = [];

    if (remote.manifest !== null) {
      const pullRes = await applyPullOps(this.ctx, p.operations, remote.manifest, signal);
      entries = pullRes.entries;
      conflicts = pullRes.conflicts;
      if (pullRes.aborted) {
        return this.report(startedAt, "aborted", entries, fromGen, fromGen, conflicts);
      }
      this.adoptBase(remote.manifest);
      await this.saveState();
    }

    const pushOps = p.operations.filter(isPushOp);
    let toGen = remote.manifest === null ? fromGen : remote.generation;
    if (pushOps.length > 0) {
      const pushRes = await applyPushOps(this.ctx, pushOps, local, signal);
      entries = [...entries, ...pushRes.entries];
      if (pushRes.aborted) {
        return this.report(startedAt, "aborted", entries, fromGen, toGen, conflicts);
      }
      const generation = remote.generation + 1;
      const next = buildNextManifest(
        this.ctx,
        remote.manifest,
        generation,
        pushRes.uploaded,
        pushRes.tombstoned,
      );
      const published = await publishManifest(this.ctx, next);
      if (!published.ok) {
        return this.report(startedAt, "pull-first", entries, fromGen, toGen, conflicts);
      }
      this.adoptBase(next);
      await this.saveState();
      toGen = generation;
    }

    const outcome: SyncOutcome =
      conflicts.length > 0 ? "conflicts" : entries.length > 0 ? "applied" : "no-op";
    return this.report(startedAt, outcome, entries, fromGen, toGen, conflicts);
  }

  verifyAccess(signal?: AbortSignal): Promise<{ generation: number; files: number } | null> {
    return this.exclusive(async () => {
      if (signal?.aborted === true) throw new SyncError("Aborted", "verifyAccess aborted");
      const remote = await readRemote(this.ctx);
      if (remote.manifest === null) return null; // nothing published yet
      return {
        generation: remote.generation,
        files: Object.keys(remote.manifest.files).length,
      };
    });
  }

  async status(): Promise<SyncStatus> {
    const locked = this.running;
    return this.exclusive(async () => {
      await this.loadStateOnce();
      const { local, planOptions } = await this.scanLocal();
      const changes = detectLocalChanges(local, this.base, planOptions.syncable);
      const status: SyncStatus = {
        baseGeneration: this.base?.generation ?? null,
        dirtyFiles:
          changes.added.length + changes.modified.length + changes.deleted.length,
        locked,
        forgottenObjects: this.base?.forgotten?.length ?? 0,
      };
      if (this.lastReport !== undefined) status.lastReport = this.lastReport;
      return status;
    });
  }
}

export function createSyncEngine(config: SyncEngineConfig): SyncEngine {
  return new Engine(config);
}
