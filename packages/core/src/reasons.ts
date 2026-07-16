// Reason codes — RFC-0007 §5. The vocabulary of "no magic": every mutation maps
// to exactly one code, and rendering is centralized here so the log, UI, and
// dry-run all speak the same language.

export enum ReasonCode {
  NewLocalFile = "new local file → uploaded",
  LocalChanged = "local hash differs from base → uploaded",
  RemoteNewer = "remote version is newer → downloaded",
  NewRemoteFile = "new remote file → downloaded",
  DeletedRemotely = "marked as deleted in manifest → removed locally",
  DeletedLocally = "deleted locally → tombstoned remotely",
  ConflictBothChanged = "changed on both sides → conflict (not merged)",
  ConflictSamePath = "same path created independently → conflict",
  ConflictEditDelete = "edited on one side, deleted on the other → conflict",
  ConvergedNoop = "already in sync → nothing to do",
}

/** The centralized human-readable rendering of a reason (the enum value itself). */
export function reasonMessage(reason: ReasonCode): string {
  return reason;
}
