// Passphrase unlock modal (ADR-0016): the passphrase is read from the input,
// handed to the callback, and never stored anywhere.
//
// The modal is the place where a wrong passphrase must be visible: it stays
// open until the caller confirms the vault actually opened, and reports the
// failure inline instead of vanishing and leaving a line in the log.

import { Modal, Setting, type App } from "obsidian";

import { EN_STRINGS, type Strings } from "./i18n.js";
import { unlockFailureMessage } from "./unlock-error.js";

export class PassphraseModal extends Modal {
  private passphrase = "";
  private submitted = false;
  private busy = false;
  private errorEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private submitButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    /** Resolves when the vault is genuinely open; rejects to keep the modal up. */
    private readonly onSubmit: (passphrase: string) => Promise<void>,
    private readonly onCancel?: () => void,
    private readonly t: Strings = EN_STRINGS,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.t.unlockModal.title);
    this.contentEl.createEl("p", { text: this.t.unlockModal.intro });
    new Setting(this.contentEl).setName(this.t.unlockModal.passphrase).addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.style.width = "100%";
      this.inputEl = text.inputEl;
      text.onChange((v) => {
        this.passphrase = v;
        this.clearError();
      });
      text.inputEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") void this.submit();
      });
      window.setTimeout(() => { text.inputEl.focus(); }, 0);
    });

    this.errorEl = this.contentEl.createEl("div");
    this.errorEl.style.color = "var(--text-error)";
    this.errorEl.style.margin = "0.5em 0";
    this.errorEl.style.whiteSpace = "pre-wrap";
    this.errorEl.hide();

    new Setting(this.contentEl).addButton((btn) => {
      this.submitButton = btn.buttonEl;
      btn.setButtonText(this.t.unlockModal.unlock).setCta().onClick(() => void this.submit());
    });
  }

  private clearError(): void {
    this.errorEl?.hide();
  }

  private showError(message: string): void {
    if (this.errorEl === null) return;
    this.errorEl.setText(message);
    this.errorEl.show();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.submitButton !== null) {
      this.submitButton.disabled = busy;
      this.submitButton.setText(busy ? this.t.unlockModal.checking : this.t.unlockModal.unlock);
    }
    if (this.inputEl !== null) this.inputEl.disabled = busy;
  }

  private async submit(): Promise<void> {
    if (this.busy || this.passphrase.length === 0) return;
    const passphrase = this.passphrase;
    this.clearError();
    this.setBusy(true);
    try {
      await this.onSubmit(passphrase);
      // Only a genuine unlock closes the modal.
      this.submitted = true;
      this.passphrase = "";
      this.close();
    } catch (e) {
      this.setBusy(false);
      this.passphrase = "";
      if (this.inputEl !== null) {
        this.inputEl.value = "";
        this.inputEl.focus();
      }
      this.showError(unlockFailureMessage(e, this.t));
    }
  }

  override onClose(): void {
    this.passphrase = "";
    this.contentEl.empty();
    if (!this.submitted) this.onCancel?.();
  }
}
