// The report — what actually happened (RFC-0007 §4).
//
// Everything here is DATA, never prose (ADR-0026): a reason code plus the
// facts the code alone does not carry. The engine has no language; rendering
// belongs to whoever is showing it to a person. `describeEntry()` is the
// English rendering for logs and headless callers, not the content itself.

import type { VaultPath } from "./types.js";
import type { OperationKind } from "./plan.js";
import { reasonMessage, type ReasonCode } from "./reasons.js";

/**
 * What a reason code cannot say on its own — the path a conflicted copy was
 * written to, which side of an edit-vs-delete survived. One case per outcome
 * that the UI needs to phrase differently.
 */
export type EntryDetail =
  | { code: "conflict-copy-saved"; copyPath: VaultPath }
  | { code: "remote-edit-restored" }
  | { code: "local-edit-kept" };

export interface SyncReportEntry {
  path: VaultPath;
  kind: OperationKind;
  reason: ReasonCode;
  detail?: EntryDetail;
  bytes?: number;
}

/** English rendering of one entry. A convenience, never the source of truth. */
export function describeEntry(e: SyncReportEntry): string {
  const base = reasonMessage(e.reason);
  switch (e.detail?.code) {
    case "conflict-copy-saved":
      return `${base} — remote version saved as "${e.detail.copyPath}"`;
    case "remote-edit-restored":
      return `${base} — restored the remotely-edited version; delete again to confirm`;
    case "local-edit-kept":
      return `${base} — kept the locally-edited file; it will be re-uploaded`;
    default:
      return base;
  }
}

export type SyncOutcome =
  | "applied"
  | "pull-first"
  | "needs-confirmation"
  | "conflicts"
  | "no-op"
  | "aborted"
  /** Storage holds an OLDER generation than this device already had (ADR-0038). */
  | "rolled-back";

export interface SyncReport {
  startedAt: number;
  finishedAt: number;
  entries: SyncReportEntry[];
  fromGeneration: number | null;
  toGeneration: number | null;
  outcome: SyncOutcome;
  conflicts: VaultPath[];
}
