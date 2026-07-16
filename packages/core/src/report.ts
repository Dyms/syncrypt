// The report — what actually happened (RFC-0007 §4).

import type { VaultPath } from "./types.js";
import type { OperationKind } from "./plan.js";
import type { ReasonCode } from "./reasons.js";

export interface SyncReportEntry {
  path: VaultPath;
  kind: OperationKind;
  reason: ReasonCode;
  /** Rendered one-liner, e.g. "remote version is newer → downloaded". */
  message: string;
  bytes?: number;
}

export type SyncOutcome =
  | "applied"
  | "pull-first"
  | "needs-confirmation"
  | "conflicts"
  | "no-op"
  | "aborted";

export interface SyncReport {
  startedAt: number;
  finishedAt: number;
  entries: SyncReportEntry[];
  fromGeneration: number | null;
  toGeneration: number | null;
  outcome: SyncOutcome;
  conflicts: VaultPath[];
}
