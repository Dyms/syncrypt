// Reclaiming storage, with the preview first (ADR-0030).
//
// The only irreversible thing in the product gets the plainest screen in it:
// what would be deleted, how much that frees, what is still waiting and until
// when, and — said out loud, where the decision is made — that nothing puts a
// deleted object back. The preview is NOT what gets executed: the engine
// recomputes reachability at the moment of deletion.

import { Modal, type App } from "obsidian";

import type { ReclaimPlan } from "@syncrypt/core";

import { formatBytes } from "./format-bytes.js";
import { EN_STRINGS, type Strings } from "./i18n.js";

export class ReclaimStorageModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly plan: ReclaimPlan,
    private readonly onDecision: (approved: boolean) => void,
    private readonly t: Strings = EN_STRINGS,
  ) {
    super(app);
  }

  override onOpen(): void {
    const t = this.t.reclaimModal;
    this.titleEl.setText(t.title);

    const canSweep = this.plan.sweep.length > 0;
    const canPrune = this.plan.prunedManifests.length > 0;

    if (!canSweep && !canPrune && this.plan.waiting === 0) {
      this.contentEl.createEl("p", { text: t.nothing });
      this.button(t.close, false, false);
      return;
    }

    if (canSweep) {
      this.contentEl.createEl("p", {
        text: t.ready(this.plan.sweep.length, formatBytes(this.plan.sweepBytes)),
      });
    }
    if (canPrune) {
      this.contentEl.createEl("p", { text: t.alsoManifests(this.plan.prunedManifests.length) });
    }
    if (this.plan.waiting > 0 && this.plan.ripeAt !== null) {
      const when = new Date(this.plan.ripeAt * 1000).toLocaleString();
      this.contentEl.createEl("p", {
        text: t.waiting(this.plan.waiting, formatBytes(this.plan.waitingBytes), when),
      });
      const marked = this.contentEl.createEl("p", { text: t.marked });
      marked.style.opacity = "0.8";
    }

    // The reason this operation is allowed to exist, next to the button that
    // performs it — not only in an ADR nobody reading this has open.
    const danger = this.contentEl.createEl("p", { text: t.danger });
    danger.style.opacity = "0.8";

    if (!canSweep && !canPrune) {
      this.button(t.close, false, false);
      return;
    }
    this.button(t.confirm, true, true);
  }

  private button(label: string, approves: boolean, withCancel: boolean): void {
    const buttons = this.contentEl.createEl("div");
    buttons.style.display = "flex";
    buttons.style.gap = "0.5em";
    buttons.style.justifyContent = "flex-end";
    if (withCancel) {
      const cancel = buttons.createEl("button", { text: this.t.reclaimModal.cancel });
      cancel.addEventListener("click", () => { this.decide(false); });
    }
    const ok = buttons.createEl("button", {
      text: label,
      ...(approves ? { cls: "mod-warning" } : {}),
    });
    ok.addEventListener("click", () => { this.decide(approves); });
  }

  private decide(approved: boolean): void {
    this.decided = true;
    this.close();
    this.onDecision(approved);
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.onDecision(false); // closing = do nothing
  }
}
