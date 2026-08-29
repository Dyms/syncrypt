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
  Manifest,
  ManifestEntry,
  ObjectKey,
  VaultPath,
} from "../types.js";
import { applyPullOps, applyPushOps, buildNextManifest } from "./apply.js";
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
  safeSync?: Partial<PlanOptions> & { versionsToKeep?: number };
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
}

const noopLog: LogPort = {
  entry: () => undefined,
  info: () => undefined,
  warn: () => undefined,
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
      },
      versionsToKeep: config.safeSync?.versionsToKeep ?? 3,
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
      this.ctx.log.warn(`local sync state unreadable — will fully reconcile (${String(e)})`);
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
      this.ctx.log.info(`sync outcome: ${outcome}`);
    }
    this.lastReport = r;
    return r;
  }

  // -- RFC-0007 §7 surface ----------------------------------------------------

  pull(signal?: AbortSignal): Promise<SyncReport> {
    return this.exclusive(() => this.doPull(signal));
  }

  private async doPull(signal?: AbortSignal): Promise<SyncReport> {
    const startedAt = this.ctx.clock.now();
    await this.loadStateOnce();
    const fromGen = this.base?.generation ?? null;
    const remote = await readRemote(this.ctx);
    const local = await scanVault(this.ctx.vault, this.ctx.crypto, this.cache, signal);
    if (signal?.aborted) {
      // A partial scan must never be mistaken for mass deletion.
      return this.report(startedAt, "aborted", [], fromGen, fromGen);
    }
    const p = plan(local, this.base, remote.manifest, this.ctx.planOptions);

    if (p.requiresConfirmation) {
      // Invariant §8.7: never auto-apply; the caller must confirmAndApply.
      this.ctx.log.warn(p.confirmationReason ?? "confirmation required");
      return this.report(startedAt, "needs-confirmation", [], fromGen, fromGen);
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
    const local = await scanVault(this.ctx.vault, this.ctx.crypto, this.cache, signal);
    if (signal?.aborted) {
      // A partial scan must never be mistaken for mass deletion.
      return this.report(startedAt, "aborted", [], fromGen, fromGen);
    }
    const p = plan(local, this.base, remote.manifest, this.ctx.planOptions);

    if (p.pullFirst) {
      // ADR-0002 / RFC-0002 FR-8: someone published since our last pull.
      this.ctx.log.info("Sync stopped. Please pull first.");
      return this.report(startedAt, "pull-first", [], fromGen, fromGen);
    }
    if (p.requiresConfirmation) {
      this.ctx.log.warn(p.confirmationReason ?? "confirmation required");
      return this.report(startedAt, "needs-confirmation", [], fromGen, fromGen);
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
      this.ctx.log.info("Sync stopped. Please pull first.");
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

  dryRun(signal?: AbortSignal): Promise<SyncPlan> {
    return this.exclusive(async () => {
      await this.loadStateOnce();
      const remote = await readRemote(this.ctx);
      const local = await scanVault(this.ctx.vault, this.ctx.crypto, this.cache, signal);
      return plan(local, this.base, remote.manifest, this.ctx.planOptions);
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
    const local = await scanVault(this.ctx.vault, this.ctx.crypto, this.cache, signal);
    if (signal?.aborted) {
      return this.report(startedAt, "aborted", [], fromGen, fromGen);
    }
    const fresh = plan(local, this.base, remote.manifest, this.ctx.planOptions);
    const confirmedDestructive = new Set(
      confirmed.operations.map(destructiveKey).filter((k) => k !== null),
    );
    const unconfirmed = fresh.operations.filter((op) => {
      const k = destructiveKey(op);
      return k !== null && !confirmedDestructive.has(k);
    });
    if (unconfirmed.length > 0) {
      this.ctx.log.warn(
        `plan changed since confirmation (${unconfirmed.length} new destructive operations) — confirm again`,
      );
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
      const local = await scanVault(this.ctx.vault, this.ctx.crypto, this.cache);
      const changes = detectLocalChanges(local, this.base, this.ctx.planOptions.syncable);
      const status: SyncStatus = {
        baseGeneration: this.base?.generation ?? null,
        dirtyFiles:
          changes.added.length + changes.modified.length + changes.deleted.length,
        locked,
      };
      if (this.lastReport !== undefined) status.lastReport = this.lastReport;
      return status;
    });
  }
}

export function createSyncEngine(config: SyncEngineConfig): SyncEngine {
  return new Engine(config);
}
