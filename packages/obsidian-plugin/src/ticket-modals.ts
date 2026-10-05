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
import { unlockFailureMessage } from "./unlock-error.js";

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
    // Taken ONCE. The check below runs Argon2id for seconds with the field
    // still live; reading `this.passphrase` again afterwards sealed the ticket
    // with whatever was in the field by then — a stray keystroke made exactly
    // the ticket the check exists to prevent (audit №4, B7).
    const passphrase = this.passphrase;
    if (passphrase.length === 0) return;
    // The passphrase is checked against the VAULT first. A typo used to
    // produce a ticket that decrypts into settings nobody can unlock, and the
    // person only found out on the other device (ADR-0048).
    let wrong: boolean;
    try {
      wrong = await this.plugin.passphraseIsWrong(passphrase);
    } catch (e) {
      // This device cannot afford the vault's KDF, so it cannot check — and an
      // unchecked passphrase is not sealed into a ticket (ADR-0063).
      new Notice(unlockFailureMessage(e, this.plugin.t()), 12000);
      return;
    }
    if (wrong) {
      new Notice(this.plugin.t().notices.sharePassphraseWrong, 8000);
      return;
    }
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
    const ticket = await createConnectionTicket(input, passphrase);
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
      // A ticket never expires (ADR-0020), on the stated grounds that it
      // carries its creation time so a UI can show it. The UI never did. One
      // recovered from a chat a year later used to enrol a device in silence.
      this.plugin.logTicketAge(payload.createdAt);
      // Rolled back if the write fails (the old order left this device pointed
      // at the ticket's provider in memory while the notice said "rejected").
      // In place, so an open settings tab shows and edits the new values; and
      // an unlocked device is locked — with or without keys in the ticket, it
      // is a different connection (audit №4, A5/W3).
      await this.plugin.replaceSettings(applyTicketToSettings(this.plugin.settings, payload));
      const passphrase = this.passphrase;
      this.passphrase = "";
      this.close();
      if (ticketIsCredsLess(payload)) {
        new Notice(t.notices.ticketImportedNoCreds, 10000);
        return;
      }
      new Notice(t.notices.ticketImported);
      // Connecting is a SEPARATE step: the ticket was accepted and saved
      // whatever happens next, so a connection failure must not be reported
      // as "ticket rejected".
      // Reports its own failure — a connection problem is not a rejected
      // ticket, and the ticket has already been accepted and saved.
      await this.plugin.connectWithPassphrase(passphrase);
    } catch (e) {
      // Nothing was applied — openConnectionTicket is all-or-nothing, and the
      // settings are rolled back above if persisting them failed.
      new Notice(t.notices.ticketRejected(String(e)), 8000);
    }
  }

  override onClose(): void {
    this.passphrase = "";
    this.ticket = "";
    this.contentEl.empty();
  }
}
