// Passphrase unlock modal (ADR-0016): the passphrase is read from the input,
// handed to the callback, and never stored anywhere.

import { Modal, Setting, type App } from "obsidian";

export class PassphraseModal extends Modal {
  private passphrase = "";
  private submitted = false;

  constructor(
    app: App,
    private readonly onSubmit: (passphrase: string) => void,
    private readonly onCancel?: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Unlock Syncrypt");
    this.contentEl.createEl("p", {
      text: "Your passphrase decrypts this vault. It is never stored — keys live in memory until Obsidian closes or you lock.",
    });
    new Setting(this.contentEl).setName("Passphrase").addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.style.width = "100%";
      text.onChange((v) => (this.passphrase = v));
      text.inputEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") this.submit();
      });
      window.setTimeout(() => { text.inputEl.focus(); }, 0);
    });
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText("Unlock").setCta().onClick(() => { this.submit(); }),
    );
  }

  private submit(): void {
    if (this.passphrase.length === 0) return;
    this.submitted = true;
    const passphrase = this.passphrase;
    this.passphrase = "";
    this.close();
    this.onSubmit(passphrase);
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) this.onCancel?.();
  }
}
