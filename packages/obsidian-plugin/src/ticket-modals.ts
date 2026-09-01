// "Share connection" / "Add device" modals (ADR-0020). One human secret — the
// vault passphrase; machine credentials ride inside the encrypted ticket.

import { Modal, Notice, Setting, type App } from "obsidian";

import {
  createConnectionTicket,
  openConnectionTicket,
  type ConnectionTicketInput,
} from "@syncrypt/crypto";

import type SyncryptPlugin from "./main.js";
import { applyTicketToSettings, ticketIsCredsLess } from "./ticket-flow.js";

export class ShareConnectionModal extends Modal {
  private passphrase = "";
  private includeCreds = true;

  constructor(
    app: App,
    private readonly plugin: SyncryptPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    const t = this.plugin.t();
    this.titleEl.setText(t.shareModal.title);
    this.contentEl.createEl("p", { text: t.shareModal.intro });
    new Setting(this.contentEl)
      .setName(t.shareModal.includeCreds)
      .setDesc(t.shareModal.includeCredsDesc)
      .addToggle((t) =>
        t.setValue(this.includeCreds).onChange((v) => {
          this.includeCreds = v;
        }),
      );
    new Setting(this.contentEl).setName(t.shareModal.passphrase).addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.style.width = "100%";
      text.onChange((v) => (this.passphrase = v));
    });
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText(t.shareModal.generate).setCta().onClick(() => void this.generate()),
    );
  }

  private async generate(): Promise<void> {
    if (this.passphrase.length === 0) return;
    const settings = this.plugin.settings;
    const s3 = settings.s3;
    const dav = settings.webdav;
    // The ticket describes the provider this device actually uses (ADR-0033);
    // a device enrolled from it comes up pointed at the same backend.
    const input: ConnectionTicketInput =
      settings.provider === "webdav"
        ? {
            provider: "webdav",
            url: dav.url,
            prefix: dav.prefix,
            ...(this.includeCreds ? { username: dav.username, password: dav.password } : {}),
          }
        : {
            provider: "s3",
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            prefix: s3.prefix,
            forcePathStyle: s3.forcePathStyle,
            ...(this.includeCreds
              ? { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey }
              : {}),
          };
    const ticket = await createConnectionTicket(input, this.passphrase);
    this.passphrase = "";

    const t = this.plugin.t();
    this.contentEl.empty();
    this.titleEl.setText(t.shareModal.resultTitle);
    this.contentEl.createEl("p", { text: t.shareModal.resultIntro });
    const area = this.contentEl.createEl("textarea");
    area.value = ticket;
    area.readOnly = true;
    area.style.width = "100%";
    area.style.height = "8em";
    const copy = this.contentEl.createEl("button", { text: t.shareModal.copy });
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(ticket).then(() => {
        new Notice(t.notices.ticketCopied);
      });
    });
  }

  override onClose(): void {
    this.passphrase = "";
    this.contentEl.empty();
  }
}

export class AddDeviceModal extends Modal {
  private ticket = "";
  private passphrase = "";

  constructor(
    app: App,
    private readonly plugin: SyncryptPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    const t = this.plugin.t();
    this.titleEl.setText(t.addDeviceModal.title);
    this.contentEl.createEl("p", { text: t.addDeviceModal.intro });
    const area = this.contentEl.createEl("textarea");
    area.placeholder = t.addDeviceModal.ticketPlaceholder;
    area.style.width = "100%";
    area.style.height = "8em";
    area.addEventListener("input", () => (this.ticket = area.value));
    new Setting(this.contentEl).setName(t.addDeviceModal.passphrase).addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.style.width = "100%";
      text.onChange((v) => (this.passphrase = v));
    });
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText(t.addDeviceModal.connect).setCta().onClick(() => void this.connect()),
    );
  }

  private async connect(): Promise<void> {
    if (this.ticket.trim().length === 0 || this.passphrase.length === 0) return;
    const t = this.plugin.t();
    try {
      // Decrypt LOCALLY first (fail-closed); only then touch settings/network.
      const payload = await openConnectionTicket(this.ticket, this.passphrase);
      this.plugin.settings = applyTicketToSettings(this.plugin.settings, payload);
      await this.plugin.saveSettings();
      const passphrase = this.passphrase;
      this.passphrase = "";
      this.close();
      if (ticketIsCredsLess(payload)) {
        new Notice(t.notices.ticketImportedNoCreds, 10000);
        return;
      }
      new Notice(t.notices.ticketImported);
      await this.plugin.connectWithPassphrase(passphrase);
    } catch (e) {
      // Nothing was applied — openConnectionTicket is all-or-nothing.
      new Notice(t.notices.ticketRejected(String(e)), 8000);
    }
  }

  override onClose(): void {
    this.passphrase = "";
    this.ticket = "";
    this.contentEl.empty();
  }
}
