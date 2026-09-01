// What a conflict actually costs the user to fix: the path that conflicted and
// the path the other device's version was parked at.
//
// The engine already reports both — `report.conflicts` carries the paths and
// the matching entry carries `detail.conflict-copy-saved` with the copy's path
// (ADR-0012). Until now every surface showed only the COUNT, which is how the
// status bar could say "1 conflict — merge them and sync again" without ever
// naming a file. Pure on purpose: no Obsidian import, so it is unit-testable.

import type { SyncReportEntry, VaultPath } from "@syncrypt/core";

export interface ConflictItem {
  /** The path that conflicted — the version this device kept. */
  path: VaultPath;
  /** Where the other device's version was written, when a copy was made. */
  copyPath?: VaultPath;
}

export interface ConflictSource {
  conflicts: readonly VaultPath[];
  entries: readonly SyncReportEntry[];
}

/**
 * Pair every conflicted path with its conflicted copy. Order follows
 * `report.conflicts`; duplicates are collapsed. A conflict with no copy (the
 * push-side case, where nothing was materialized yet) still appears — the user
 * needs to know the path even when there is nothing beside it yet.
 */
export function collectConflicts(report: ConflictSource): ConflictItem[] {
  const copies = new Map<VaultPath, VaultPath>();
  for (const e of report.entries) {
    if (e.detail?.code === "conflict-copy-saved") copies.set(e.path, e.detail.copyPath);
  }
  const seen = new Set<VaultPath>();
  const out: ConflictItem[] = [];
  for (const path of report.conflicts) {
    if (seen.has(path)) continue;
    seen.add(path);
    const copyPath = copies.get(path);
    out.push(copyPath === undefined ? { path } : { path, copyPath });
  }
  return out;
}

/** The conflicted copy for one path, when the report materialized one. */
export function conflictCopyFor(
  report: ConflictSource,
  path: VaultPath,
): VaultPath | undefined {
  for (const e of report.entries) {
    if (e.path === path && e.detail?.code === "conflict-copy-saved") return e.detail.copyPath;
  }
  return undefined;
}

/**
 * A path list short enough for a tooltip or a log line: the first `limit`
 * paths, plus how many were left out. Never truncates in the middle of a path —
 * a half-path is worse than no path.
 */
export function shortlist(
  paths: readonly VaultPath[],
  limit: number,
): { shown: VaultPath[]; more: number } {
  if (paths.length <= limit) return { shown: [...paths], more: 0 };
  return { shown: paths.slice(0, limit), more: paths.length - limit };
}
