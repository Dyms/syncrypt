// The human-readable sync log view: one line per applied file with its
// ReasonCode message ("no magic"). Never shows secrets — it only renders what
// LogBuffer received, and the engine logs reasons, not internals.

import { ItemView, type WorkspaceLeaf } from "obsidian";

import type { LogBuffer } from "./log-buffer.js";

export const SYNC_LOG_VIEW_TYPE = "syncrypt-log";

export class SyncLogView extends ItemView {
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly buffer: LogBuffer,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return SYNC_LOG_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "Syncrypt log";
  }

  override getIcon(): string {
    return "refresh-cw";
  }

  override async onOpen(): Promise<void> {
    this.render();
    this.unsubscribe = this.buffer.onChange(() => { this.render(); });
    return Promise.resolve();
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
    container.createEl("h4", { text: "Sync log" });
    const list = container.createEl("div", { cls: "syncrypt-log" });
    list.style.fontFamily = "var(--font-monospace)";
    list.style.fontSize = "0.85em";
    const lines = this.buffer.all();
    if (lines.length === 0) {
      list.createEl("div", { text: "Nothing synced yet." });
      return;
    }
    for (const line of [...lines].reverse()) {
      const row = list.createEl("div");
      const time = new Date(line.at).toLocaleTimeString();
      row.createSpan({ text: `${time}  ` });
      if (line.level === "warn") row.style.color = "var(--text-error)";
      if (line.path !== undefined) {
        row.createEl("b", { text: line.path });
        row.createSpan({ text: `: ${line.text}` });
      } else {
        row.createSpan({ text: line.text });
      }
    }
  }
}
