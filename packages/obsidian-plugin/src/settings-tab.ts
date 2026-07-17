// Settings UI: S3 provider config, sync profile, Safe Sync knobs, unlock flow.
// The ADR-0016 credential warning lives right next to the credential fields.

import { Notice, PluginSettingTab, Setting, type App } from "obsidian";

import type SyncryptPlugin from "./main.js";

export class SyncryptSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SyncryptPlugin,
  ) {
    super(app, plugin);
  }

  // display() remains the supported imperative API; the declarative
  // getSettingDefinitions (1.13+) cannot express the unlock flow or the
  // dynamic credential warning yet.
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    // --- Vault lock state -----------------------------------------------
    new Setting(containerEl)
      .setName(this.plugin.isUnlocked() ? "Unlocked" : "Locked")
      .setDesc(
        this.plugin.isUnlocked()
          ? "Keys are in memory for this session."
          : "Enter your passphrase to start syncing. It is never stored.",
      )
      .addButton((btn) =>
        btn
          .setButtonText(this.plugin.isUnlocked() ? "Lock" : "Unlock…")
          .setCta()
          .onClick(() => {
            if (this.plugin.isUnlocked()) this.plugin.lock();
            else this.plugin.promptUnlock();
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- re-render; see note on display()
            this.display();
          }),
      );

    // --- S3 provider -------------------------------------------------------
    new Setting(containerEl).setName("Storage (S3-compatible)").setHeading();
    containerEl.createEl("p", {
      text:
        "⚠ Credentials are stored unencrypted in this plugin's data.json (see ADR-0016). " +
        "Use least-privilege keys scoped to a single bucket/prefix, and enable bucket versioning. " +
        "Your notes are protected by the passphrase, which is never written to disk.",
      cls: "mod-warning",
    });

    const s3Text = (
      name: string,
      get: () => string,
      set: (v: string) => void,
      opts: { placeholder?: string; secret?: boolean } = {},
    ): void => {
      new Setting(containerEl).setName(name).addText((text) => {
        if (opts.secret === true) text.inputEl.type = "password";
        text
          .setPlaceholder(opts.placeholder ?? "")
          .setValue(get())
          .onChange(async (v) => {
            set(v.trim());
            await this.plugin.saveSettings();
          });
      });
    };
    s3Text("Endpoint", () => s.s3.endpoint, (v) => (s.s3.endpoint = v), {
      placeholder: "https://s3.example.com",
    });
    s3Text("Region", () => s.s3.region, (v) => (s.s3.region = v));
    s3Text("Bucket", () => s.s3.bucket, (v) => (s.s3.bucket = v));
    s3Text("Prefix", () => s.s3.prefix, (v) => (s.s3.prefix = v), {
      placeholder: "vaults/main (optional)",
    });
    s3Text("Access key ID", () => s.s3.accessKeyId, (v) => (s.s3.accessKeyId = v));
    s3Text(
      "Secret access key",
      () => s.s3.secretAccessKey,
      (v) => (s.s3.secretAccessKey = v),
      { secret: true },
    );
    new Setting(containerEl)
      .setName("Path-style addressing")
      .setDesc("Keep on for MinIO/R2/self-hosted; some AWS setups need it off.")
      .addToggle((t) =>
        t.setValue(s.s3.forcePathStyle).onChange(async (v) => {
          s.s3.forcePathStyle = v;
          await this.plugin.saveSettings();
        }),
      );

    // --- Sync profile ------------------------------------------------------
    new Setting(containerEl).setName("Sync profile").setHeading();
    const profileArea = (
      name: string,
      desc: string,
      get: () => string[],
      set: (v: string[]) => void,
    ): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addTextArea((area) => {
          area.setValue(get().join("\n")).onChange(async (v) => {
            set(v.split("\n").map((l) => l.trim()).filter((l) => l !== ""));
            await this.plugin.saveSettings();
          });
        });
    };
    profileArea("Include", "One glob per line.", () => s.profile.include, (v) => (s.profile.include = v));
    profileArea(
      "Exclude",
      "One glob per line. Dot-folders and .obsidian/sync-trash are always excluded.",
      () => s.profile.exclude,
      (v) => (s.profile.exclude = v),
    );

    // --- Safe Sync ----------------------------------------------------------
    new Setting(containerEl).setName("Safe Sync (ADR-0010/0013)").setHeading();
    const num = (
      name: string,
      desc: string,
      get: () => number,
      set: (v: number) => void,
    ): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text.setValue(String(get())).onChange(async (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0) {
              set(n);
              await this.plugin.saveSettings();
            }
          }),
        );
    };
    num(
      "Confirmation floor",
      "Destructive changes at or below this count never prompt (0 = strict).",
      () => s.safeSync.bulkChangeFloor,
      (v) => (s.safeSync.bulkChangeFloor = Math.floor(v)),
    );
    num(
      "Always confirm at",
      "Destructive changes at or above this count always prompt.",
      () => s.safeSync.bulkChangeMaxFiles,
      (v) => (s.safeSync.bulkChangeMaxFiles = Math.floor(v)),
    );
    num(
      "Vault fraction",
      "Between floor and cap, prompt when the change exceeds this fraction (0.1 = 10%).",
      () => s.safeSync.bulkChangeMaxFraction,
      (v) => (s.safeSync.bulkChangeMaxFraction = v),
    );
    num(
      "Versions to keep",
      "Prior encrypted versions retained per changed file.",
      () => s.safeSync.versionsToKeep,
      (v) => (s.safeSync.versionsToKeep = Math.floor(v)),
    );

    // --- Auto-sync -----------------------------------------------------------
    new Setting(containerEl).setName("Auto-sync").setHeading();
    new Setting(containerEl)
      .setName("Sync while editing")
      .setDesc("Debounced sync after edits settle; manual Sync now always works.")
      .addToggle((t) =>
        t.setValue(s.autoSync.enabled).onChange(async (v) => {
          s.autoSync.enabled = v;
          await this.plugin.saveSettings();
          this.plugin.reconfigureScheduler();
        }),
      );
    num(
      "Debounce (seconds)",
      "Quiet time after the last edit before an auto-sync.",
      () => s.autoSync.debounceSec,
      (v) => (s.autoSync.debounceSec = v),
    );
    num(
      "Minimum interval (seconds)",
      "At most one auto-sync per this many seconds.",
      () => s.autoSync.minIntervalSec,
      (v) => (s.autoSync.minIntervalSec = v),
    );

    new Setting(containerEl)
      .setName("Device ID")
      .setDesc(`${s.deviceId} — stable identifier used in manifests.`)
      .addButton((btn) =>
        btn.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(s.deviceId);
          new Notice("Device ID copied");
        }),
      );
  }
}
