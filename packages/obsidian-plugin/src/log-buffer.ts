// LogPort with a bounded in-memory buffer feeding the sync-log view. The log
// is a product surface (CLAUDE.md): one human-readable line per applied
// action — reasons, not internals, and NEVER secrets.
//
// Nothing here is rendered. The engine hands over codes and facts (ADR-0026),
// the buffer keeps them as they are, and the view phrases them in the reader's
// language — so switching language re-renders the whole history, including
// lines written before the switch.

import type {
  EngineNotice,
  EntryDetail,
  LogPort,
  ReasonCode,
  SyncReportEntry,
} from "@syncrypt/core";

export interface LogLine {
  at: number; // epoch ms
  level: "entry" | "info" | "warn";
  /** An applied change: the reason code plus what the code cannot say alone. */
  reason?: ReasonCode;
  detail?: EntryDetail;
  path?: string;
  /** Something the engine reported that is not about one file. */
  notice?: EngineNotice;
  /** The plugin's OWN messages, already in the reader's language. */
  text?: string;
}

/** Which notices read as a warning rather than as progress. */
const WARNING_NOTICES: ReadonlySet<EngineNotice["code"]> = new Set([
  "confirmation-required",
  "fork-lost",
  "vault-written-by-newer",
  "confirmation-stale",
  "state-unreadable",
  "dedup-probe-unavailable",
]);

export class LogBuffer implements LogPort {
  private readonly lines: LogLine[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly maxLines = 500) {}

  entry(e: SyncReportEntry): void {
    const line: LogLine = { at: Date.now(), level: "entry", reason: e.reason, path: e.path };
    if (e.detail !== undefined) line.detail = e.detail;
    this.push(line);
  }

  notice(n: EngineNotice): void {
    this.push({
      at: Date.now(),
      level: WARNING_NOTICES.has(n.code) ? "warn" : "info",
      notice: n,
    });
  }

  // -- the plugin's own messages, already localized by the caller ------------

  info(msg: string): void {
    this.push({ at: Date.now(), level: "info", text: msg });
  }

  warn(msg: string): void {
    this.push({ at: Date.now(), level: "warn", text: msg });
  }

  private push(line: LogLine): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
    for (const fn of this.listeners) fn();
  }

  all(): readonly LogLine[] {
    return this.lines;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
