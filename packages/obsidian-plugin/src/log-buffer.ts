// LogPort with a bounded in-memory buffer feeding the sync-log view. The log
// is a product surface (CLAUDE.md): one human-readable line per applied
// action — reasons, not internals, and NEVER secrets.

import type { LogPort, ReasonCode, SyncReportEntry } from "@syncrypt/core";

export interface LogLine {
  at: number; // epoch ms
  level: "entry" | "info" | "warn";
  /** English rendering exactly as the engine produced it; display fallback. */
  text: string;
  path?: string;
  /**
   * The stable reason behind an applied change (ADR-0021). The view renders
   * THIS in the reader's language and falls back to `text` when absent, so
   * switching language re-renders the whole history correctly.
   */
  reason?: ReasonCode;
}

export class LogBuffer implements LogPort {
  private readonly lines: LogLine[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly maxLines = 500) {}

  entry(e: SyncReportEntry): void {
    this.push({
      at: Date.now(),
      level: "entry",
      text: e.message,
      path: e.path,
      reason: e.reason,
    });
  }

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
