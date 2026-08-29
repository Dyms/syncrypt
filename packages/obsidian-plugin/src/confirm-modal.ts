// Safe-Sync confirmation modal (ADR-0010 §4, RFC-0007 §8.7): shows WHY the
// breaker fired and EVERY affected file before anything destructive happens.
// Approval calls back so the caller can run confirmAndApply.

import { Modal, type App } from "obsidian";

import type { SyncPlan } from "@syncrypt/core";

import { EN_STRINGS, type Strings } from "./i18n.js";

export class ConfirmSyncModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly plan: SyncPlan,
    private readonly onDecision: (approved: boolean) => void,
    private readonly t: Strings = EN_STRINGS,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.t.confirmModal.title);
    // The engine says WHY in numbers (ADR-0026); the sentence is ours, so the
    // most alarming message in the plugin is not the one stuck in English.
    const why = this.plan.confirmationReason;
    this.contentEl.createEl("p", {
      text:
        why === undefined
          ? this.t.confirmModal.fallbackReason
          : this.t.engine.confirmationRequired(why.destructive, why.total),
    });

    const destructive = this.plan.operations.filter(
      (op) =>
        op.kind === "delete-local" ||
        op.kind === "delete-remote" ||
        (op.kind === "download" && op.localHash !== undefined),
    );
    const listEl = this.contentEl.createEl("div", { cls: "syncrypt-confirm-list" });
    listEl.style.maxHeight = "40vh";
    listEl.style.overflow = "auto";
    const labels: Record<string, string> = {
      "delete-local": this.t.confirmModal.deleteLocal,
      "delete-remote": this.t.confirmModal.deleteRemote,
      download: this.t.confirmModal.overwriteLocal,
    };
    for (const op of destructive) {
      const row = listEl.createEl("div");
      row.createEl("code", { text: op.path });
      row.createSpan({ text: ` — ${labels[op.kind] ?? op.kind}` });
    }

    const buttons = this.contentEl.createEl("div");
    buttons.style.display = "flex";
    buttons.style.gap = "0.5em";
    buttons.style.justifyContent = "flex-end";
    const cancel = buttons.createEl("button", { text: this.t.confirmModal.cancel });
    cancel.addEventListener("click", () => { this.decide(false); });
    const ok = buttons.createEl("button", {
      text: this.t.confirmModal.apply(destructive.length),
      cls: "mod-warning",
    });
    ok.addEventListener("click", () => { this.decide(true); });
  }

  private decide(approved: boolean): void {
    this.decided = true;
    this.close();
    this.onDecision(approved);
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.onDecision(false); // closing = cancel, never apply
  }
}
