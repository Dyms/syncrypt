// The comparison view (RFC-0010): two labelled sides and a line diff, loaded
// when the window opens. Read-only: it has no buttons that change anything.

import { Modal, type App } from "obsidian";

import type { Comparison, SideInfo } from "./compare-loader.js";
import { VersionGoneError } from "./compare-loader.js";
import { formatBytes } from "./format-bytes.js";
import { EN_STRINGS, type Strings } from "./i18n.js";
import type { DiffResult, Hunk } from "./text-diff.js";

export class CompareModal extends Modal {
  private closed = false;

  constructor(
    app: App,
    private readonly path: string,
    private readonly load: () => Promise<Comparison>,
    private readonly onClosed: () => void,
    private readonly t: Strings = EN_STRINGS,
  ) {
    super(app);
  }

  override onOpen(): void {
    const t = this.t.compareModal;
    this.titleEl.setText(t.title(this.path));
    const body = this.contentEl.createEl("div");
    body.createEl("p", { text: t.loading });
    this.load().then(
      (c) => {
        if (this.closed) return;
        body.empty();
        this.render(body, c);
      },
      (e: unknown) => {
        if (this.closed) return;
        body.empty();
        const msg = e instanceof VersionGoneError ? t.gone : e instanceof Error ? e.message : String(e);
        body.createEl("p", { text: e instanceof VersionGoneError ? msg : t.failed(msg) });
      },
    );
    const buttons = this.contentEl.createEl("div");
    buttons.style.textAlign = "right";
    const close = buttons.createEl("button", { text: t.close });
    close.addEventListener("click", () => { this.close(); });
  }

  private sideLine(label: string, info: SideInfo): string {
    const t = this.t.compareModal;
    const where =
      info.side.kind === "local" ? t.local : info.side.kind === "stored" ? t.stored : t.absent;
    if (info.size === null) return `${label}: ${where}`;
    const when = info.mtime === null ? "?" : new Date(info.mtime * 1000).toLocaleString();
    return `${label}: ${where} — ${t.meta(formatBytes(info.size), when)}`;
  }

  private render(body: ReturnType<Modal["contentEl"]["createEl"]>, c: Comparison): void {
    const t = this.t.compareModal;
    body.createEl("div", { text: this.sideLine(t.sideLeft, c.left) });
    body.createEl("div", { text: this.sideLine(t.sideRight, c.right) });
    const r: DiffResult = c.result;
    const note = (text: string): void => {
      const p = body.createEl("p", { text });
      p.style.marginTop = "0.8em";
    };
    switch (r.kind) {
      case "identical":
        note(t.identical);
        return;
      case "format-only":
        note(t.formatOnly);
        return;
      case "binary":
        note(t.binary);
        return;
      case "too-large":
        note(
          r.reason === "bytes"
            ? t.tooLargeBytes
            : r.reason === "lines"
              ? t.tooLargeLines
              : t.tooLargeEdits,
        );
        return;
      case "hunks": {
        const sum = body.createEl("p", { text: `${t.summary(r.added, r.removed)}   (${t.legend})` });
        sum.style.marginTop = "0.8em";
        const box = body.createEl("div", { cls: "syncrypt-diff" });
        box.style.maxHeight = "50vh";
        box.style.overflow = "auto";
        box.style.fontFamily = "var(--font-monospace)";
        box.style.fontSize = "0.85em";
        for (const h of r.hunks) this.renderHunk(box, h);
        return;
      }
    }
  }

  private renderHunk(box: ReturnType<Modal["contentEl"]["createEl"]>, h: Hunk): void {
    const first = (pick: "oldNo" | "newNo"): number =>
      h.lines.find((l) => l[pick] !== undefined)?.[pick] ?? 0;
    const head = box.createEl("div", { text: `@@ −${String(first("oldNo"))} +${String(first("newNo"))} @@` });
    head.style.opacity = "0.6";
    head.style.marginTop = "0.6em";
    for (const l of h.lines) {
      const mark = l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  ";
      const row = box.createEl("div", { text: mark + l.text });
      row.style.whiteSpace = "pre-wrap";
      if (l.kind === "add") row.style.background = "var(--background-modifier-success)";
      if (l.kind === "del") row.style.background = "var(--background-modifier-error)";
    }
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    this.onClosed();
  }
}
