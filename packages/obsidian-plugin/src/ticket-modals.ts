// "Share connection" / "Add device" modals (ADR-0020). One human secret — the
// vault passphrase; machine credentials ride inside the encrypted ticket.

import { Modal, Notice, Setting, type App } from "obsidian";

import { createConnectionTicket, openConnectionTicket } from "@syncrypt/crypto";

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
    this.titleEl.setText("Share connection (add another device)");
    this.contentEl.createEl("p", {
      text:
        "Creates an encrypted ticket with this device's storage settings. " +
        "The ticket is exactly as strong as your passphrase — it is useless " +
        "without it, but a weak passphrase makes it a weak ticket.",
    });
    new Setting(this.contentEl)
      .setName("Include storage credentials")
      .setDesc("Off = the other device types the keys manually (config only).")
      .addToggle((t) =>
        t.setValue(this.includeCreds).onChange((v) => {
          this.includeCreds = v;
        }),
      );
    new Setting(this.contentEl).setName("Vault passphrase").addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.style.width = "100%";
      text.onChange((v) => (this.passphrase = v));
    });
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText("Generate ticket").setCta().onClick(() => void this.generate()),
    );
  }

  private async generate(): Promise<void> {
    if (this.passphrase.length === 0) return;
    const s = this.plugin.settings.s3;
    const ticket = await createConnectionTicket(
      {
        provider: "s3",
        endpoint: s.endpoint,
        region: s.region,
        bucket: s.bucket,
        prefix: s.prefix,
        forcePathStyle: s.forcePathStyle,
        ...(this.includeCreds
          ? { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey }
          : {}),
      },
      this.passphrase,
    );
    this.passphrase = "";

    this.contentEl.empty();
    this.titleEl.setText("Your connection ticket");
    this.contentEl.createEl("p", {
      text:
        "On the other device: install Syncrypt, run “Add this device from a " +
        "ticket”, paste this, and enter the same passphrase. Then DELETE the " +
        "message you used to transfer it — treat the ticket like a secret.",
    });
    const area = this.contentEl.createEl("textarea");
    area.value = ticket;
    area.readOnly = true;
    area.style.width = "100%";
    area.style.height = "8em";
    const copy = this.contentEl.createEl("button", { text: "Copy to clipboard" });
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(ticket).then(() => {
        new Notice("Ticket copied.");
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
    this.titleEl.setText("Add this device from a ticket");
    this.contentEl.createEl("p", {
      text: "Paste the connection ticket from your other device and enter your vault passphrase.",
    });
    const area = this.contentEl.createEl("textarea");
    area.placeholder = "Connection ticket…";
    area.style.width = "100%";
    area.style.height = "8em";
    area.addEventListener("input", () => (this.ticket = area.value));
    new Setting(this.contentEl).setName("Vault passphrase").addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.style.width = "100%";
      text.onChange((v) => (this.passphrase = v));
    });
    new Setting(this.contentEl).addButton((btn) =>
      btn.setButtonText("Connect").setCta().onClick(() => void this.connect()),
    );
  }

  private async connect(): Promise<void> {
    if (this.ticket.trim().length === 0 || this.passphrase.length === 0) return;
    try {
      // Decrypt LOCALLY first (fail-closed); only then touch settings/network.
      const payload = await openConnectionTicket(this.ticket, this.passphrase);
      this.plugin.settings = applyTicketToSettings(this.plugin.settings, payload);
      await this.plugin.saveSettings();
      const passphrase = this.passphrase;
      this.passphrase = "";
      this.close();
      if (ticketIsCredsLess(payload)) {
        new Notice(
          "Connection settings imported WITHOUT credentials — enter the storage keys in Settings, then Unlock.",
          10000,
        );
        return;
      }
      new Notice("Connection imported. Connecting… (delete the transferred ticket now)");
      await this.plugin.connectWithPassphrase(passphrase);
    } catch (e) {
      // Nothing was applied — openConnectionTicket is all-or-nothing.
      new Notice(`Syncrypt: ticket rejected — ${String(e)}`, 8000);
    }
  }

  override onClose(): void {
    this.passphrase = "";
    this.ticket = "";
    this.contentEl.empty();
  }
}
