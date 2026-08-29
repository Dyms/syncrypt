// The human-readable sync log view: one line per applied file with its
// ReasonCode message ("no magic"). Never shows secrets — it only renders what
// LogBuffer received, and the engine logs reasons, not internals.

import { ItemView, type WorkspaceLeaf } from "obsidian";

import { EN_STRINGS, type Strings } from "./i18n.js";
import type { LogBuffer } from "./log-buffer.js";
import { renderLine } from "./log-render.js";

export const SYNC_LOG_VIEW_TYPE = "syncrypt-log";

export class SyncLogView extends ItemView {
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly buffer: LogBuffer,
    /** Read at render time, so switching language repaints the whole log. */
    private readonly strings: () => Strings = () => EN_STRINGS,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return SYNC_LOG_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return this.strings().log.viewTitle;
  }

  override getIcon(): string {
    return "refresh-cw";
  }

  override async onOpen(): Promise<void> {
    this.render();
    this.unsubscribe = this.buffer.onChange(() => { this.render(); });
    return Promise.resolve();
  }

  /** Repaint after a language change (ADR-0021). */
  refresh(): void {
    this.render();
  }

  override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return Promise.resolve();
  }

  private render(): void {
    const container = this.containerEl.children[1];
    if (!(container instanceof HTMLElement)) return;
    container.empty();
    const t = this.strings();
    container.createEl("h4", { text: t.log.heading });
    const list = container.createEl("div", { cls: "syncrypt-log" });
    list.style.fontFamily = "var(--font-monospace)";
    list.style.fontSize = "0.85em";
    const lines = this.buffer.all();
    if (lines.length === 0) {
      list.createEl("div", { text: t.log.empty });
      return;
    }
    for (const line of [...lines].reverse()) {
      const row = list.createEl("div");
      const time = new Date(line.at).toLocaleTimeString();
      row.createSpan({ text: `${time}  ` });
      if (line.level === "warn") row.style.color = "var(--text-error)";
      // Everything the engine said arrives as codes (ADR-0026) and is phrased
      // here, so switching language re-renders history too. Only the plugin's
      // own messages come in already-final form.
      const text = renderLine(line, t);
      if (line.path !== undefined) {
        row.createEl("b", { text: line.path });
        row.createSpan({ text: `: ${text}` });
      } else {
        row.createSpan({ text });
      }
    }
  }
}
