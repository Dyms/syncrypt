// Settings UI: language, S3 provider config, device enrollment, sync profile,
// Safe Sync knobs, unlock flow. Every visible string comes from i18n
// (ADR-0021); the ADR-0016 credential note sits next to the credential fields.

import { Notice, PluginSettingTab, Setting, type App } from "obsidian";

import { SECRET_BEARING_PLUGINS } from "./config-sync.js";
import { endpointIsPlaintext } from "./endpoint-warning.js";
import type { Strings } from "./i18n.js";
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
  // dynamic credential note yet.
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const t: Strings = this.plugin.t();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- re-render; see note on display()
    const rerender = (): void => { this.display(); };

    // --- Sync status (same honest derivation as the status bar) ----------
    const view = this.plugin.getStatusView();
    const statusSetting = new Setting(containerEl)
      .setName(view.label.replace(/^Syncrypt: /, t.status.statusPrefix))
      .setDesc(view.tooltip.replaceAll("\n", " — "));
    statusSetting.addButton((btn) =>
      btn.setButtonText(t.settings.syncNow).onClick(async () => {
        await this.plugin.syncNow("manual");
        rerender();
      }),
    );
    statusSetting.addButton((btn) =>
      btn.setButtonText(t.settings.showLog).onClick(() => void this.plugin.activateLogView()),
    );

    // --- Vault lock state -----------------------------------------------
    new Setting(containerEl)
      .setName(this.plugin.isUnlocked() ? t.settings.unlockedName : t.settings.lockedName)
      .setDesc(this.plugin.isUnlocked() ? t.settings.unlockedDesc : t.settings.lockedDesc)
      .addButton((btn) =>
        btn
          .setButtonText(this.plugin.isUnlocked() ? t.settings.lockButton : t.settings.unlockButton)
          .setCta()
          .onClick(() => {
            if (this.plugin.isUnlocked()) this.plugin.lock();
            else this.plugin.promptUnlock();
            rerender();
          }),
      );

    // --- Interface (ADR-0021) ---------------------------------------------
    new Setting(containerEl).setName(t.settings.interfaceHeading).setHeading();
    new Setting(containerEl)
      .setName(t.settings.language)
      .setDesc(
        `${t.settings.languageDesc} ${t.settings.languageDetected(this.plugin.languageDiagnostics())}`,
      )
      .addDropdown((d) =>
        d
          .addOption("auto", t.settings.languageAuto)
          .addOption("en", t.settings.languageEn)
          .addOption("ru", t.settings.languageRu)
          .setValue(s.language)
          .onChange(async (v) => {
            s.language = v === "en" || v === "ru" ? v : "auto";
            await this.plugin.saveSettings();
            this.plugin.applyLanguage();
            this.plugin.refreshSurfaces();
            rerender();
          }),
      );

    // --- S3 provider -------------------------------------------------------
    new Setting(containerEl).setName(t.settings.storageHeading).setHeading();
    // ADR-0016, stated once and calmly: a note, not an alarm. Shown only once
    // keys are actually stored — before that there is nothing to warn about.
    if (s.s3.accessKeyId !== "" || s.s3.secretAccessKey !== "") {
      containerEl.createEl("div", {
        text: `⚠ ${t.settings.credentialWarning}`,
        cls: "setting-item-description",
      });
    }

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
    s3Text(t.settings.endpoint, () => s.s3.endpoint, (v) => (s.s3.endpoint = v), {
      placeholder: "https://s3.example.com",
    });
    if (endpointIsPlaintext(s.s3.endpoint)) {
      // The vault's contents are encrypted before they leave, but the storage
      // credentials are not: over plain HTTP they travel in the clear, and for
      // WebDAV Basic auth that is the password itself.
      const warn = containerEl.createEl("div", {
        text: `⚠ ${t.settings.plaintextEndpointWarning}`,
        cls: "setting-item-description",
      });
      warn.style.color = "var(--text-error)";
    }
    s3Text(t.settings.region, () => s.s3.region, (v) => (s.s3.region = v));
    s3Text(t.settings.bucket, () => s.s3.bucket, (v) => (s.s3.bucket = v));
    s3Text(t.settings.prefix, () => s.s3.prefix, (v) => (s.s3.prefix = v), {
      placeholder: t.settings.prefixPlaceholder,
    });
    s3Text(t.settings.accessKeyId, () => s.s3.accessKeyId, (v) => (s.s3.accessKeyId = v));
    s3Text(
      t.settings.secretAccessKey,
      () => s.s3.secretAccessKey,
      (v) => (s.s3.secretAccessKey = v),
      { secret: true },
    );
    new Setting(containerEl)
      .setName(t.settings.pathStyle)
      .setDesc(t.settings.pathStyleDesc)
      .addToggle((tg) =>
        tg.setValue(s.s3.forcePathStyle).onChange(async (v) => {
          s.s3.forcePathStyle = v;
          await this.plugin.saveSettings();
        }),
      );

    // --- Devices (ADR-0020) -------------------------------------------------
    new Setting(containerEl).setName(t.settings.devicesHeading).setHeading();
    new Setting(containerEl)
      .setName(t.settings.shareConnection)
      .setDesc(t.settings.shareConnectionDesc)
      .addButton((btn) =>
        btn.setButtonText(t.settings.shareConnectionButton).onClick(() => {
          this.plugin.openShareConnection();
        }),
      );
    new Setting(containerEl)
      .setName(t.settings.addDevice)
      .setDesc(t.settings.addDeviceDesc)
      .addButton((btn) =>
        btn.setButtonText(t.settings.addDeviceButton).onClick(() => {
          this.plugin.openAddDevice();
        }),
      );

    // --- Sync profile ------------------------------------------------------
    new Setting(containerEl).setName(t.settings.profileHeading).setHeading();
    containerEl.createEl("div", {
      text: t.settings.profileIntro,
      cls: "setting-item-description",
    });
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
    profileArea(
      t.settings.include,
      t.settings.includeDesc,
      () => s.profile.include,
      (v) => (s.profile.include = v),
    );
    profileArea(
      t.settings.exclude,
      t.settings.excludeDesc,
      () => s.profile.exclude,
      (v) => (s.profile.exclude = v),
    );
    new Setting(containerEl)
      .setName(t.settings.profileCheck)
      .setDesc(t.settings.profileCheckDesc)
      .addButton((btn) =>
        btn.setButtonText(t.settings.profileCheckButton).onClick(async () => {
          const seen = await this.plugin.previewProfile();
          new Notice(
            t.settings.profileCheckResult(seen.files, seen.notes, seen.attachments),
            8000,
          );
        }),
      );

    // --- Obsidian settings sync (RFC-0008) ----------------------------------
    new Setting(containerEl).setName(t.settings.configSyncHeading).setHeading();
    containerEl.createEl("div", {
      text: t.settings.configSyncIntro,
      cls: "setting-item-description",
    });
    new Setting(containerEl)
      .setName(t.settings.configSyncEnabled)
      .setDesc(t.settings.configSyncEnabledDesc)
      .addToggle((tg) =>
        tg.setValue(s.configSync.enabled).onChange(async (v) => {
          s.configSync.enabled = v;
          await this.plugin.saveSettings();
          // Turning it ON does NOT publish: the vault may already have a
          // profile, and the next sync adopts it rather than being overwritten
          // by this device's defaults (ADR-0024).
          rerender();
        }),
      );

    if (s.configSync.enabled) {
      const item = (
        name: string,
        desc: string,
        get: () => boolean,
        set: (v: boolean) => void,
      ): void => {
        new Setting(containerEl)
          .setName(name)
          .setDesc(desc)
          .addToggle((tg) =>
            tg.setValue(get()).onChange(async (v) => {
              set(v);
              await this.plugin.saveSettings();
              await this.plugin.publishSharedConfig(); // ADR-0024
            }),
          );
      };
      item(t.settings.configAppearance, t.settings.configAppearanceDesc,
        () => s.configSync.appearance, (v) => (s.configSync.appearance = v));
      item(t.settings.configApp, t.settings.configAppDesc,
        () => s.configSync.app, (v) => (s.configSync.app = v));
      item(t.settings.configHotkeys, t.settings.configHotkeysDesc,
        () => s.configSync.hotkeys, (v) => (s.configSync.hotkeys = v));
      item(t.settings.configThemes, t.settings.configThemesDesc,
        () => s.configSync.themes, (v) => (s.configSync.themes = v));
      item(t.settings.configSnippets, t.settings.configSnippetsDesc,
        () => s.configSync.snippets, (v) => (s.configSync.snippets = v));
      item(t.settings.configCorePlugins, t.settings.configCorePluginsDesc,
        () => s.configSync.corePlugins, (v) => (s.configSync.corePlugins = v));
      item(t.settings.configCommunityList, t.settings.configCommunityListDesc,
        () => s.configSync.communityPluginsList, (v) => (s.configSync.communityPluginsList = v));

      // Per-plugin opt-in. The list is read asynchronously; the section fills
      // in when the manifests come back.
      new Setting(containerEl).setName(t.settings.configPluginsHeading).setHeading();
      containerEl.createEl("div", {
        text: t.settings.configPluginsIntro,
        cls: "setting-item-description",
      });
      const pluginsEl = containerEl.createEl("div");
      pluginsEl.createEl("div", {
        text: t.settings.configPluginsLoading,
        cls: "setting-item-description",
      });
      void this.plugin.listInstalledPlugins().then((plugins) => {
        pluginsEl.empty();
        if (plugins.length === 0) {
          pluginsEl.createEl("div", {
            text: t.settings.configNoPlugins,
            cls: "setting-item-description",
          });
          return;
        }
        for (const plugin of plugins) {
          const secret = SECRET_BEARING_PLUGINS.has(plugin.id);
          new Setting(pluginsEl)
            .setName(secret ? `${plugin.name} — ⚠ ${t.settings.configPluginSecret}` : plugin.name)
            .setDesc(plugin.id)
            .addToggle((tg) =>
              tg.setValue(s.configSync.plugins.includes(plugin.id)).onChange(async (v) => {
                const kept = s.configSync.plugins.filter((id) => id !== plugin.id);
                s.configSync.plugins = v ? [...kept, plugin.id] : kept;
                await this.plugin.saveSettings();
                await this.plugin.publishSharedConfig(); // ADR-0024
                if (v && secret) {
                  new Notice(t.settings.configPluginSecretWarning(plugin.name), 10000);
                }
              }),
            );
        }
      });
    }

    // --- Safe Sync ----------------------------------------------------------
    new Setting(containerEl).setName(t.settings.safeSyncHeading).setHeading();
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
      t.settings.confirmationFloor,
      t.settings.confirmationFloorDesc,
      () => s.safeSync.bulkChangeFloor,
      (v) => (s.safeSync.bulkChangeFloor = Math.floor(v)),
    );
    num(
      t.settings.alwaysConfirmAt,
      t.settings.alwaysConfirmAtDesc,
      () => s.safeSync.bulkChangeMaxFiles,
      (v) => (s.safeSync.bulkChangeMaxFiles = Math.floor(v)),
    );
    num(
      t.settings.vaultFraction,
      t.settings.vaultFractionDesc,
      () => s.safeSync.bulkChangeMaxFraction,
      (v) => (s.safeSync.bulkChangeMaxFraction = v),
    );
    num(
      t.settings.versionsToKeep,
      t.settings.versionsToKeepDesc,
      () => s.safeSync.versionsToKeep,
      (v) => (s.safeSync.versionsToKeep = Math.floor(v)),
    );

    // --- Vault creation profile (ADR-0018) -----------------------------------
    new Setting(containerEl)
      .setName(t.settings.kdfProfile)
      .setDesc(t.settings.kdfProfileDesc)
      .addDropdown((d) =>
        d
          .addOption("cross-device", t.settings.kdfCrossDevice)
          .addOption("desktop-only", t.settings.kdfDesktopOnly)
          .setValue(s.kdfProfile)
          .onChange(async (v) => {
            s.kdfProfile = v === "desktop-only" ? "desktop-only" : "cross-device";
            await this.plugin.saveSettings();
          }),
      );

    // --- Auto-sync -----------------------------------------------------------
    new Setting(containerEl).setName(t.settings.autoSyncHeading).setHeading();
    new Setting(containerEl)
      .setName(t.settings.syncWhileEditing)
      .setDesc(t.settings.syncWhileEditingDesc)
      .addToggle((tg) =>
        tg.setValue(s.autoSync.enabled).onChange(async (v) => {
          s.autoSync.enabled = v;
          await this.plugin.saveSettings();
          this.plugin.reconfigureScheduler();
        }),
      );
    new Setting(containerEl)
      .setName(t.settings.wifiOnly)
      .setDesc(t.settings.wifiOnlyDesc)
      .addToggle((tg) =>
        tg.setValue(s.autoSync.wifiOnly).onChange(async (v) => {
          s.autoSync.wifiOnly = v;
          await this.plugin.saveSettings();
        }),
      );
    num(
      t.settings.debounce,
      t.settings.debounceDesc,
      () => s.autoSync.debounceSec,
      (v) => (s.autoSync.debounceSec = v),
    );
    num(
      t.settings.minInterval,
      t.settings.minIntervalDesc,
      () => s.autoSync.minIntervalSec,
      (v) => (s.autoSync.minIntervalSec = v),
    );

    new Setting(containerEl)
      .setName(t.settings.deviceId)
      .setDesc(t.settings.deviceIdDesc(s.deviceId))
      .addButton((btn) =>
        btn.setButtonText(t.settings.copy).onClick(async () => {
          await navigator.clipboard.writeText(s.deviceId);
          new Notice(t.notices.deviceIdCopied);
        }),
      );
  }
}
