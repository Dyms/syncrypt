// Manifest cleanup, with the preview first (ADR-0027).
//
// The list is CANDIDATES, not orphans: a device cannot see other devices'
// profiles, so all it honestly knows is "my profile does not cover these".
// Everything is unticked to start with — the user picks, one path at a time,
// after reading what each one is.

import { Modal, type App } from "obsidian";

import type { UncarriedEntry, VaultPath } from "@syncrypt/core";

import { formatBytes } from "./format-bytes.js";
import { EN_STRINGS, type Strings } from "./i18n.js";

export class ForgetPathsModal extends Modal {
  private readonly selected = new Set<VaultPath>();
  private decided = false;

  constructor(
    app: App,
    private readonly candidates: UncarriedEntry[],
    private readonly onDecision: (paths: VaultPath[]) => void,
    private readonly t: Strings = EN_STRINGS,
  ) {
    super(app);
  }

  override onOpen(): void {
    const t = this.t.forgetModal;
    this.titleEl.setText(t.title);
    this.contentEl.createEl("p", { text: t.intro(this.candidates.length) });
    // The safety property is the reason this operation is allowed to exist —
    // say it where the decision is made, not only in the docs.
    const safety = this.contentEl.createEl("p", { text: t.safety });
    safety.style.opacity = "0.8";

    if (this.candidates.length === 0) {
      this.contentEl.createEl("p", { text: t.empty });
      return;
    }

    const listEl = this.contentEl.createEl("div");
    listEl.style.maxHeight = "40vh";
    listEl.style.overflow = "auto";
    for (const c of this.candidates) {
      const row = listEl.createEl("label");
      row.style.display = "flex";
      row.style.alignItems = "baseline";
      row.style.gap = "0.5em";
      const box = row.createEl("input", { type: "checkbox" });
      box.addEventListener("change", () => {
        if (box.checked) this.selected.add(c.path);
        else this.selected.delete(c.path);
        this.renderCount();
      });
      row.createEl("code", { text: c.path });
      const meta = row.createSpan({
        text: ` ${formatBytes(c.size)} · ${new Date(c.mtime * 1000).toLocaleDateString()}`,
      });
      meta.style.opacity = "0.7";
    }

    const buttons = this.contentEl.createEl("div");
    buttons.style.display = "flex";
    buttons.style.gap = "0.5em";
    buttons.style.justifyContent = "flex-end";
    const cancel = buttons.createEl("button", { text: t.cancel });
    cancel.addEventListener("click", () => { this.decide([]); });
    this.okButton = buttons.createEl("button", { text: t.forget(0), cls: "mod-warning" });
    this.okButton.disabled = true;
    this.okButton.addEventListener("click", () => { this.decide([...this.selected]); });
  }

  private okButton: HTMLButtonElement | null = null;

  private renderCount(): void {
    if (this.okButton === null) return;
    this.okButton.setText(this.t.forgetModal.forget(this.selected.size));
    this.okButton.disabled = this.selected.size === 0;
  }

  private decide(paths: VaultPath[]): void {
    this.decided = true;
    this.close();
    this.onDecision(paths);
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.onDecision([]); // closing = do nothing
  }
}
