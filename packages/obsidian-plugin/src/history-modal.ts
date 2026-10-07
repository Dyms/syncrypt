// File history (RFC-0010): the versions storage keeps of one file, with
// "compare" and "restore as copy". Nothing here changes the file itself.

import { Modal, type App } from "obsidian";

import type { FileVersion, FileVersions } from "@syncrypt/core";

import { formatBytes } from "./format-bytes.js";
import { EN_STRINGS, type Strings } from "./i18n.js";

export interface HistoryActions {
  compareLocal(version: FileVersion): void;
  /** `older` against the `newer` version that follows it. */
  whatChanged(older: FileVersion, newer: FileVersion): void;
  /** Resolves with the path the copy was written to. */
  restore(version: FileVersion): Promise<string>;
}

export class HistoryModal extends Modal {
  constructor(
    app: App,
    private readonly path: string,
    private readonly history: FileVersions,
    private readonly actions: HistoryActions,
    private readonly onClosed: () => void,
    private readonly t: Strings = EN_STRINGS,
  ) {
    super(app);
  }

  override onOpen(): void {
    const t = this.t.historyModal;
    this.titleEl.setText(t.title(this.path));
    if (this.history.deleted) this.contentEl.createEl("p", { text: t.deleted });
    else this.contentEl.createEl("p", { text: t.intro });

    const list = this.contentEl.createEl("div");
    list.style.maxHeight = "50vh";
    list.style.overflow = "auto";
    const versions = this.history.versions;
    versions.forEach((v, i) => {
      const row = list.createEl("div");
      row.style.margin = "0.6em 0";
      const when = new Date(v.mtime * 1000).toLocaleString();
      row.createEl("div", {
        text: `${when} — ${formatBytes(v.size)} — ${v.current ? t.current : t.earlier}`,
      });
      const buttons = row.createEl("div");
      buttons.style.display = "flex";
      buttons.style.gap = "0.5em";
      buttons.createEl("button", { text: t.compareLocal }).addEventListener("click", () => {
        this.actions.compareLocal(v);
      });
      const newer = i > 0 ? versions[i - 1] : undefined;
      if (newer !== undefined) {
        buttons.createEl("button", { text: t.whatChanged }).addEventListener("click", () => {
          this.actions.whatChanged(v, newer);
        });
      }
      const restore = buttons.createEl("button", { text: t.restore });
      restore.addEventListener("click", () => {
        restore.disabled = true; // one click, one copy
        // The caller already told the person why a restore failed.
        void this.actions
          .restore(v)
          .catch(() => undefined)
          .finally(() => { restore.disabled = false; });
      });
    });

    const footer = this.contentEl.createEl("div");
    footer.style.textAlign = "right";
    footer.createEl("button", { text: t.close }).addEventListener("click", () => { this.close(); });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.onClosed();
  }
}
