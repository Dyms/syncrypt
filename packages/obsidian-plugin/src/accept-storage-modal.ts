// Accepting a storage that went backwards (ADR-0038).
//
// The screen exists because the engine cannot tell a restore from an attack:
// both look like "the newest manifests are gone". Only the person knows which
// it was, so the modal asks that question and nothing else — and says, next to
// the button, what accepting costs and what it does not.

import { Modal, type App } from "obsidian";

import { EN_STRINGS, type Strings } from "./i18n.js";

export class AcceptStorageModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly remoteGeneration: number,
    private readonly baseGeneration: number,
    private readonly onDecision: (approved: boolean) => void,
    private readonly t: Strings = EN_STRINGS,
  ) {
    super(app);
  }

  override onOpen(): void {
    const t = this.t.acceptStorageModal;
    this.titleEl.setText(t.title);
    this.contentEl.createEl("p", {
      text: t.what(this.remoteGeneration, this.baseGeneration),
    });
    this.contentEl.createEl("p", { text: t.restored });
    // The warning is not a footnote: rolling every device back is exactly what
    // someone with write access to the bucket would do.
    this.contentEl.createEl("p", { text: t.notRestored }).style.fontWeight = "bold";
    const effect = this.contentEl.createEl("p", { text: t.effect });
    effect.style.opacity = "0.8";

    const buttons = this.contentEl.createEl("div");
    buttons.style.display = "flex";
    buttons.style.gap = "0.5em";
    buttons.style.justifyContent = "flex-end";
    const cancel = buttons.createEl("button", { text: t.cancel });
    cancel.addEventListener("click", () => { this.decide(false); });
    const ok = buttons.createEl("button", { text: t.confirm, cls: "mod-warning" });
    ok.addEventListener("click", () => { this.decide(true); });
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
