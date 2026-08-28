// Sync-status derivation — PURE and honest. The status bar and the settings
// block both render from this single function, which looks only at facts the
// engine already reports (status(), the last SyncReport, connectivity).
//
// HONESTY RULE: "Synced" appears ONLY when the vault is unlocked, nothing is
// running, the last sync completed cleanly, and there are zero dirty files —
// i.e. the local base IS the published generation. Anything less is
// "Pending". The green check never runs ahead of the truth.

import type { SyncOutcome } from "@syncrypt/core";

import { EN_STRINGS, type Strings } from "./i18n.js";

type StatusStrings = Strings["status"];

export interface SyncCounts {
  notes: number;
  attachments: number;
}

export interface SyncStateInput {
  locked: boolean;
  syncing: boolean;
  /** Files applied so far in the RUNNING sync (from sync-log events). */
  appliedSoFar: number;
  /** navigator.onLine — false means definitely offline. */
  onLine: boolean;
  /** From engine.status(); null before the first status call. */
  status: { baseGeneration: number | null; dirtyFiles: number } | null;
  lastOutcome: SyncOutcome | null;
  /** Epoch ms of the last completed sync attempt; null if none this session. */
  lastSyncAt: number | null;
  /** Classified failure of the last attempt, if it threw. */
  lastError: "network" | "other" | null;
  /** Unresolved conflicts reported by the last sync. */
  conflicts: number;
  counts: SyncCounts | null;
}

export type SyncStateKind =
  | "locked"
  | "syncing"
  | "offline"
  | "error"
  | "conflict"
  | "synced"
  | "pending";

export interface SyncStateView {
  kind: SyncStateKind;
  /** Short status-bar text. */
  label: string;
  /** Longer explanation for the tooltip / settings block. */
  tooltip: string;
}

export function deriveSyncState(
  i: SyncStateInput,
  s: StatusStrings = EN_STRINGS.status,
): SyncStateView {
  const facts = factsLine(i, s);

  if (i.locked) {
    return {
      kind: "locked",
      label: s.lockedLabel,
      tooltip: s.lockedTooltip + facts,
    };
  }
  if (i.syncing) {
    const n = i.appliedSoFar > 0 ? ` (${String(i.appliedSoFar)})` : "…";
    return {
      kind: "syncing",
      label: s.syncingLabel(n),
      tooltip: s.syncingTooltip + facts,
    };
  }
  if (!i.onLine || i.lastError === "network") {
    return {
      kind: "offline",
      label: s.offlineLabel,
      tooltip: s.offlineTooltip + facts,
    };
  }
  if (i.lastError === "other") {
    return {
      kind: "error",
      label: s.errorLabel,
      tooltip: s.errorTooltip + facts,
    };
  }
  if (i.conflicts > 0) {
    return {
      kind: "conflict",
      label: s.conflictLabel(i.conflicts),
      tooltip: s.conflictTooltip(i.conflicts) + facts,
    };
  }

  const cleanOutcome = i.lastOutcome === "applied" || i.lastOutcome === "no-op";
  const synced =
    i.status !== null &&
    i.status.baseGeneration !== null &&
    i.status.dirtyFiles === 0 &&
    cleanOutcome;
  if (synced) {
    return { kind: "synced", label: s.syncedLabel, tooltip: s.syncedTooltip + facts };
  }
  const why =
    i.status === null || i.lastOutcome === null
      ? s.pendingNoSyncYet
      : i.status.dirtyFiles > 0
        ? s.pendingDirty(i.status.dirtyFiles)
        : i.lastOutcome === "needs-confirmation"
          ? s.pendingNeedsConfirmation
          : s.pendingUnclean;
  return { kind: "pending", label: s.pendingLabel, tooltip: why + facts };
}

function factsLine(i: SyncStateInput, s: StatusStrings): string {
  const parts: string[] = [];
  if (i.lastSyncAt !== null) {
    parts.push(s.factsLastSync(new Date(i.lastSyncAt).toLocaleTimeString()));
  }
  if (i.counts !== null) {
    parts.push(s.factsCounts(i.counts.notes, i.counts.attachments));
  }
  const generation = i.status?.baseGeneration;
  if (generation !== null && generation !== undefined) {
    parts.push(s.factsGeneration(generation));
  }
  return parts.length > 0 ? `\n${parts.join(" · ")}` : "";
}

/** Note vs attachment split for the tooltip (cheap, run after each sync). */
export function classifyCounts(paths: Iterable<string>): SyncCounts {
  let notes = 0;
  let attachments = 0;
  for (const p of paths) {
    if (p.endsWith(".md") || p.endsWith(".canvas")) notes++;
    else attachments++;
  }
  return { notes, attachments };
}
