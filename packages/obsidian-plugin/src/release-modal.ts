// Releasing the copies kept for forgotten entries (ADR-0055).
//
// Forgetting a manifest entry keeps its ciphertext, because the judgement
// behind it — "no device carries this any more" — is one the user makes
// without being able to see the other devices. This screen is the second half,
// and the only place the product says out loud that those copies may be the
// last ones: it does not delete anything itself, it makes deletion possible.

import { Modal, type App } from "obsidian";

import { EN_STRINGS, type Strings } from "./i18n.js";

export class ReleaseForgottenModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly kept: number,
    private readonly onDecision: (approved: boolean) => void,
    private readonly t: Strings = EN_STRINGS,
  ) {
    super(app);
  }

  override onOpen(): void {
    const t = this.t.releaseModal;
    this.titleEl.setText(t.title);

    if (this.kept === 0) {
      this.contentEl.createEl("p", { text: t.nothing });
      this.button(t.close, false, false);
      return;
    }

    this.contentEl.createEl("p", { text: t.intro(this.kept) });
    const danger = this.contentEl.createEl("p", { text: t.danger });
    danger.style.opacity = "0.8";
    this.button(t.confirm, true, true);
  }

  private button(label: string, approves: boolean, withCancel: boolean): void {
    const buttons = this.contentEl.createEl("div");
    buttons.style.display = "flex";
    buttons.style.gap = "0.5em";
    buttons.style.justifyContent = "flex-end";
    if (withCancel) {
      const cancel = buttons.createEl("button", { text: this.t.releaseModal.cancel });
      cancel.addEventListener("click", () => {
        this.decide(false);
      });
    }
    const ok = buttons.createEl("button", {
      text: label,
      ...(approves ? { cls: "mod-warning" } : {}),
    });
    ok.addEventListener("click", () => {
      this.decide(approves);
    });
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
