// Sync-status derivation — PURE and honest. The status bar and the settings
// block both render from this single function, which looks only at facts the
// engine already reports (status(), the last SyncReport, connectivity).
//
// HONESTY RULE: "Synced" appears ONLY when the vault is unlocked, nothing is
// running, the last sync completed cleanly, and there are zero dirty files —
// i.e. the local base IS the published generation. Anything less is
// "Pending". The green check never runs ahead of the truth.

import type { SyncOutcome } from "@syncrypt/core";

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

export function deriveSyncState(i: SyncStateInput): SyncStateView {
  const facts = factsLine(i);

  if (i.locked) {
    return {
      kind: "locked",
      label: "Syncrypt: locked",
      tooltip: "Unlock with your passphrase to sync." + facts,
    };
  }
  if (i.syncing) {
    const n = i.appliedSoFar > 0 ? ` (${i.appliedSoFar})` : "…";
    return {
      kind: "syncing",
      label: `Syncrypt: syncing${n}`,
      tooltip: "Sync in progress." + facts,
    };
  }
  if (!i.onLine || i.lastError === "network") {
    return {
      kind: "offline",
      label: "Syncrypt: offline",
      tooltip: "Storage is unreachable; your edits are safe locally and will sync when the connection returns." + facts,
    };
  }
  if (i.lastError === "other") {
    return {
      kind: "error",
      label: "Syncrypt: error",
      tooltip: "The last sync failed — see the sync log." + facts,
    };
  }
  if (i.conflicts > 0) {
    return {
      kind: "conflict",
      label: `Syncrypt: conflict (${i.conflicts})`,
      tooltip:
        `${i.conflicts} conflict(s) — both versions were kept; merge them and sync again.` + facts,
    };
  }

  const cleanOutcome = i.lastOutcome === "applied" || i.lastOutcome === "no-op";
  const synced =
    i.status !== null &&
    i.status.baseGeneration !== null &&
    i.status.dirtyFiles === 0 &&
    cleanOutcome;
  if (synced) {
    return { kind: "synced", label: "Syncrypt: synced ✓", tooltip: "Everything is synced." + facts };
  }
  const why =
    i.status === null || i.lastOutcome === null
      ? "No sync has completed yet this session."
      : i.status.dirtyFiles > 0
        ? `${i.status.dirtyFiles} local change(s) not yet uploaded.`
        : i.lastOutcome === "needs-confirmation"
          ? "A bulk change is waiting for your confirmation."
          : "The last sync did not complete cleanly.";
  return { kind: "pending", label: "Syncrypt: pending", tooltip: why + facts };
}

function factsLine(i: SyncStateInput): string {
  const parts: string[] = [];
  if (i.lastSyncAt !== null) {
    parts.push(`last sync ${new Date(i.lastSyncAt).toLocaleTimeString()}`);
  }
  if (i.counts !== null) {
    parts.push(`${i.counts.notes} notes, ${i.counts.attachments} attachments`);
  }
  const generation = i.status?.baseGeneration;
  if (generation !== null && generation !== undefined) {
    parts.push(`generation #${generation}`);
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
