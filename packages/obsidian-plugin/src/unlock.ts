// Passphrase unlock modal (ADR-0016): the passphrase is read from the input,
// handed to the callback, and never stored anywhere.
//
// The modal is the place where a wrong passphrase must be visible: it stays
// open until the caller confirms the vault actually opened, and reports the
// failure inline instead of vanishing and leaving a line in the log.

import { Modal, Setting, type App } from "obsidian";

import { EN_STRINGS, type Strings } from "./i18n.js";
import { UnlockFlow } from "./unlock-flow.js";

export class PassphraseModal extends Modal {
  private passphrase = "";
  private submitted = false;
  private busy = false;
  private errorEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private submitButton: HTMLButtonElement | null = null;
  private questionEl: HTMLElement | null = null;
  private readonly flow: UnlockFlow;

  constructor(
    app: App,
    /**
     * Resolves when the vault is genuinely open; rejects to keep the modal up.
     * `create` is true only after the person confirmed creating a vault at an
     * empty location and typed the passphrase twice (ADR-0065).
     */
    onSubmit: (passphrase: string, create: boolean, confirmed: boolean) => Promise<void>,
    private readonly onCancel?: () => void,
    private readonly t: Strings = EN_STRINGS,
    /** Where the settings point, named in the "no vault here" question. */
    location = "",
  ) {
    super(app);
    this.flow = new UnlockFlow(onSubmit, t, location);
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

    this.questionEl = this.contentEl.createEl("div");
    this.questionEl.style.margin = "0.5em 0";
    this.questionEl.style.whiteSpace = "pre-wrap";
    this.questionEl.hide();

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
      const idle = this.flow.creating ? this.t.unlockModal.create : this.t.unlockModal.unlock;
      this.submitButton.setText(busy ? this.t.unlockModal.checking : idle);
    }
    if (this.inputEl !== null) this.inputEl.disabled = busy;
  }

  private async submit(): Promise<void> {
    if (this.busy || this.passphrase.length === 0) return;
    const passphrase = this.passphrase;
    this.clearError();
    this.setBusy(true);
    const step = await this.flow.submit(passphrase);
    this.passphrase = "";
    if (step.kind === "done") {
      // Only a genuine unlock closes the modal.
      this.submitted = true;
      this.busy = false;
      this.close();
      return;
    }
    if (step.kind === "confirm-create" || step.kind === "confirm-unchecked") {
      this.questionEl?.setText(step.message);
      this.questionEl?.show();
    } else {
      this.questionEl?.hide();
      this.showError(step.message);
    }
    this.setBusy(false);
    if (this.inputEl !== null) {
      this.inputEl.value = "";
      this.inputEl.focus();
    }
  }

  /**
   * Not while the passphrase is being checked. Escape used to close the dialog
   * and leave the unlock running behind it: a wrong passphrase was reported
   * into a closed window, and a right one opened a vault the person had just
   * dismissed (audit №4, B14). Argon2id takes seconds; the button says so.
   */
  override close(): void {
    if (this.busy) return;
    super.close();
  }

  /**
   * Close even mid-check: the plugin is unloading and the instance this dialog
   * answers to is gone (ADR-0081). The unlock in flight sees the unload and
   * opens nothing.
   */
  dismiss(): void {
    this.busy = false;
    super.close();
  }

  override onClose(): void {
    this.passphrase = "";
    this.flow.cancelCreate();
    this.contentEl.empty();
    if (!this.submitted) this.onCancel?.();
  }
}
