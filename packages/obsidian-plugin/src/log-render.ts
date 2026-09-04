// Phrasing for everything the engine reported (ADR-0026).
//
// Kept apart from the view on purpose: this is a pure function of (line,
// strings), so the "no English leaks to a Russian reader" guarantee is
// unit-testable without Obsidian's runtime.

import { formatBytes } from "./format-bytes.js";
import type { Strings } from "./i18n.js";
import type { LogLine } from "./log-buffer.js";

/** Phrase one buffered line in the reader's language (ADR-0026). */
export function renderLine(line: LogLine, t: Strings): string {
  if (line.reason !== undefined) {
    const base = t.reasons[line.reason];
    switch (line.detail?.code) {
      case "conflict-copy-saved":
        return `${base} — ${t.entryDetail.conflictCopySaved(line.detail.copyPath)}`;
      case "remote-edit-restored":
        return `${base} — ${t.entryDetail.remoteEditRestored}`;
      case "local-edit-kept":
        return `${base} — ${t.entryDetail.localEditKept}`;
      default:
        return base;
    }
  }
  const n = line.notice;
  if (n !== undefined) {
    switch (n.code) {
      case "sync-outcome":
        return t.engine.syncOutcome[n.outcome];
      case "pull-first":
        return t.engine.pullFirst;
      case "confirmation-required":
        return n.reason === undefined
          ? t.engine.confirmationRequiredPlain
          : t.engine.confirmationRequired(n.reason.destructive, n.reason.total);
      case "confirmation-stale":
        return t.engine.confirmationStale(n.newDestructive);
      case "state-unreadable":
        return t.engine.stateUnreadable(n.detail);
      case "dedup-probe-unavailable":
        return t.engine.dedupProbeUnavailable(n.path, n.detail);
      case "manifest-entries-forgotten":
        return t.engine.manifestEntriesForgotten(n.count, n.generation);
      case "vault-written-by-newer":
        return t.engine.vaultWrittenByNewer(n.writer, n.self);
      case "vault-written-by-older":
        return t.engine.vaultWrittenByOlder(n.writer, n.self);
      case "fork-lost":
        return t.engine.forkLost(n.generation);
      case "storage-rolled-back":
        return t.engine.storageRolledBack(n.remote, n.base);
      case "tombstones-expired":
        return t.engine.tombstonesExpired(n.count, Math.round(n.graceSeconds / 86_400));
      case "storage-reclaimed":
        return t.engine.storageReclaimed(
          n.deleted,
          formatBytes(n.bytesFreed),
          n.prunedManifests,
          n.waiting,
        );
      case "forgotten-objects-released":
        return t.engine.forgottenObjectsReleased(n.count, n.generation);
      case "paths-not-distinct":
        return t.engine.pathsNotDistinct(n.paths);
      case "deletions-paced":
        return t.engine.deletionsPaced(
          n.discount.paced,
          n.discount.spanSeconds,
          n.discount.destructive,
        );
    }
  }
  return line.text ?? "";
}
