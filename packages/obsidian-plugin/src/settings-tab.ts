// Settings UI: language, S3 provider config, device enrollment, sync profile,
// Safe Sync knobs, unlock flow. Every visible string comes from i18n
// (ADR-0021); the ADR-0016 credential note sits next to the credential fields.
//
// Everything below the status block lives in a collapsible section. Nine
// headings of knobs on one scroll is a page nobody reads to the bottom of —
// and the things a person actually opens settings for (is it synced? is it
// unlocked?) were at the top of a very long document. Which sections are open
// is remembered per device; the rule itself is in settings-sections.ts.

import { Notice, PluginSettingTab, Setting, type App } from "obsidian";

import { SECRET_BEARING_PLUGINS } from "./config-sync.js";
import { endpointIsPlaintext } from "./endpoint-warning.js";
import type { Strings } from "./i18n.js";
import type SyncryptPlugin from "./main.js";
import {
  browserSectionMemory,
  sectionOpen,
  type SectionId,
  type SectionMemory,
} from "./settings-sections.js";
import { endpointOf, settingsComplete } from "./settings.js";

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
    const configured = settingsComplete(s);
    const memory: SectionMemory = browserSectionMemory(
      typeof localStorage === "undefined" ? undefined : localStorage,
    );
    /** One collapsible heading; returns the body to put the settings into. */
    const section = (id: SectionId, title: string): HTMLElement => {
      const details = containerEl.createEl("details");
      details.open = sectionOpen(id, memory.read(id), configured);
      const summary = details.createEl("summary", { text: title });
      summary.style.cursor = "pointer";
      summary.style.fontWeight = "var(--font-semibold)";
      summary.style.padding = "0.7em 0";
      summary.style.borderTop = "1px solid var(--background-modifier-border)";
      details.addEventListener("toggle", () => { memory.write(id, details.open); });
      return details.createEl("div");
    };

    // --- Which build is this? --------------------------------------------
    // Installed through BRAT, the first question is always "did the update
    // actually land?". The answer is in the manifest; show it quietly.
    const versionEl = containerEl.createEl("div", {
      text: t.settings.version(this.plugin.manifest.version),
    });
    versionEl.style.textAlign = "right";
    versionEl.style.color = "var(--text-muted)";
    versionEl.style.fontSize = "0.8em";
    versionEl.style.marginBottom = "0.5em";

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
    const interfaceEl = section("interface", t.settings.interfaceHeading);
    new Setting(interfaceEl)
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

    // --- Storage provider ---------------------------------------------------
    const storageEl = section("storage", t.settings.storageHeading);
    const webdav = s.provider === "webdav";

    new Setting(storageEl)
      .setName(t.settings.provider)
      .setDesc(t.settings.providerDesc)
      .addDropdown((d) =>
        d
          .addOption("s3", t.settings.providerS3)
          .addOption("webdav", t.settings.providerWebdav)
          .setValue(s.provider)
          .onChange(async (v) => {
            // Switching providers does not clear the other one's settings: a
            // user comparing two backends should not have to retype either.
            // Nothing is connected until Unlock, and the engine is rebuilt
            // from scratch there.
            s.provider = v === "webdav" ? "webdav" : "s3";
            await this.plugin.saveSettings();
            if (this.plugin.isUnlocked()) this.plugin.lock();
            rerender();
          }),
      );

    // ADR-0016, stated once and calmly: a note, not an alarm. Shown only once
    // credentials are actually stored — before that there is nothing to warn
    // about. WebDAV's password sits in the same file for the same reason.
    const hasSecrets = webdav
      ? s.webdav.username !== "" || s.webdav.password !== ""
      : s.s3.accessKeyId !== "" || s.s3.secretAccessKey !== "";
    if (hasSecrets) {
      storageEl.createEl("div", {
        text: `⚠ ${t.settings.credentialWarning}`,
        cls: "setting-item-description",
      });
    }

    const storageText = (
      name: string,
      get: () => string,
      set: (v: string) => void,
      opts: { placeholder?: string; secret?: boolean } = {},
    ): void => {
      new Setting(storageEl).setName(name).addText((text) => {
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

    const plaintextWarning = (): void => {
      if (!endpointIsPlaintext(endpointOf(s))) return;
      // The vault's contents are encrypted before they leave, but the storage
      // credentials are not: over plain HTTP they travel in the clear, and for
      // WebDAV Basic auth that IS the password, on every single request.
      const warn = storageEl.createEl("div", {
        text: `⚠ ${webdav ? t.settings.plaintextWebdavWarning : t.settings.plaintextEndpointWarning}`,
        cls: "setting-item-description",
      });
      warn.style.color = "var(--text-error)";
    };

    if (webdav) {
      storageText(t.settings.webdavUrl, () => s.webdav.url, (v) => (s.webdav.url = v), {
        placeholder: "https://cloud.example.com/remote.php/dav/files/user/vault",
      });
      plaintextWarning();
      storageText(
        t.settings.webdavUsername,
        () => s.webdav.username,
        (v) => (s.webdav.username = v),
      );
      storageText(
        t.settings.webdavPassword,
        () => s.webdav.password,
        (v) => (s.webdav.password = v),
        { secret: true },
      );
      storageEl.createEl("div", {
        text: t.settings.webdavAppPasswordHint,
        cls: "setting-item-description",
      });
      storageText(t.settings.prefix, () => s.webdav.prefix, (v) => (s.webdav.prefix = v), {
        placeholder: t.settings.prefixPlaceholder,
      });
      // ADR-0006: WebDAV has no conditional writes, so two devices publishing
      // the same generation are resolved by the LIST rule instead of being
      // prevented. Nothing is lost — but the user should know it is different.
      storageEl.createEl("div", {
        text: t.settings.webdavNoConditionalWrites,
        cls: "setting-item-description",
      });
    } else {
      storageText(t.settings.endpoint, () => s.s3.endpoint, (v) => (s.s3.endpoint = v), {
        placeholder: "https://s3.example.com",
      });
      plaintextWarning();
      storageText(t.settings.region, () => s.s3.region, (v) => (s.s3.region = v));
      storageText(t.settings.bucket, () => s.s3.bucket, (v) => (s.s3.bucket = v));
      storageText(t.settings.prefix, () => s.s3.prefix, (v) => (s.s3.prefix = v), {
        placeholder: t.settings.prefixPlaceholder,
      });
      storageText(
        t.settings.accessKeyId,
        () => s.s3.accessKeyId,
        (v) => (s.s3.accessKeyId = v),
      );
      storageText(
        t.settings.secretAccessKey,
        () => s.s3.secretAccessKey,
        (v) => (s.s3.secretAccessKey = v),
        { secret: true },
      );
      new Setting(storageEl)
        .setName(t.settings.pathStyle)
        .setDesc(t.settings.pathStyleDesc)
        .addToggle((tg) =>
          tg.setValue(s.s3.forcePathStyle).onChange(async (v) => {
            s.s3.forcePathStyle = v;
            await this.plugin.saveSettings();
          }),
        );
    }

    // --- Devices (ADR-0020) -------------------------------------------------
    const devicesEl = section("devices", t.settings.devicesHeading);
    new Setting(devicesEl)
      .setName(t.settings.shareConnection)
      .setDesc(t.settings.shareConnectionDesc)
      .addButton((btn) =>
        btn.setButtonText(t.settings.shareConnectionButton).onClick(() => {
          this.plugin.openShareConnection();
        }),
      );
    new Setting(devicesEl)
      .setName(t.settings.addDevice)
      .setDesc(t.settings.addDeviceDesc)
      .addButton((btn) =>
        btn.setButtonText(t.settings.addDeviceButton).onClick(() => {
          this.plugin.openAddDevice();
        }),
      );

    // --- Sync profile ------------------------------------------------------
    const profileEl = section("profile", t.settings.profileHeading);
    profileEl.createEl("div", {
      text: t.settings.profileIntro,
      cls: "setting-item-description",
    });
    const profileArea = (
      name: string,
      desc: string,
      get: () => string[],
      set: (v: string[]) => void,
    ): void => {
      new Setting(profileEl)
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
    new Setting(profileEl)
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
    const configEl = section("configSync", t.settings.configSyncHeading);
    configEl.createEl("div", {
      text: t.settings.configSyncIntro,
      cls: "setting-item-description",
    });
    new Setting(configEl)
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
        new Setting(configEl)
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
      new Setting(configEl).setName(t.settings.configPluginsHeading).setHeading();
      configEl.createEl("div", {
        text: t.settings.configPluginsIntro,
        cls: "setting-item-description",
      });
      const pluginsEl = configEl.createEl("div");
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
    const safeEl = section("safeSync", t.settings.safeSyncHeading);
    const num = (
      into: HTMLElement,
      name: string,
      desc: string,
      get: () => number,
      set: (v: number) => void,
    ): void => {
      new Setting(into)
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
      safeEl,
      t.settings.confirmationFloor,
      t.settings.confirmationFloorDesc,
      () => s.safeSync.bulkChangeFloor,
      (v) => (s.safeSync.bulkChangeFloor = Math.floor(v)),
    );
    num(
      safeEl,
      t.settings.alwaysConfirmAt,
      t.settings.alwaysConfirmAtDesc,
      () => s.safeSync.bulkChangeMaxFiles,
      (v) => (s.safeSync.bulkChangeMaxFiles = Math.floor(v)),
    );
    num(
      safeEl,
      t.settings.vaultFraction,
      t.settings.vaultFractionDesc,
      () => s.safeSync.bulkChangeMaxFraction,
      (v) => (s.safeSync.bulkChangeMaxFraction = v),
    );
    num(
      safeEl,
      t.settings.deletionBurstWindow,
      t.settings.deletionBurstWindowDesc,
      () => s.safeSync.deletionBurstWindow,
      (v) => (s.safeSync.deletionBurstWindow = Math.floor(v)),
    );
    num(
      safeEl,
      t.settings.versionsToKeep,
      t.settings.versionsToKeepDesc,
      () => s.safeSync.versionsToKeep,
      (v) => (s.safeSync.versionsToKeep = Math.floor(v)),
    );
    // Days and hours in the UI, seconds in the engine: nobody reasons about a
    // deletion-memory window in seconds.
    num(
      safeEl,
      t.settings.tombstoneGrace,
      t.settings.tombstoneGraceDesc,
      () => Math.round(s.safeSync.tombstoneGraceSeconds / 86_400),
      (v) => (s.safeSync.tombstoneGraceSeconds = Math.floor(v) * 86_400),
    );
    num(
      safeEl,
      t.settings.reclaimGrace,
      t.settings.reclaimGraceDesc,
      () => Math.round(s.safeSync.reclaimGraceSeconds / 3600),
      (v) => (s.safeSync.reclaimGraceSeconds = Math.max(1, Math.floor(v)) * 3600),
    );
    num(
      safeEl,
      t.settings.generationsToKeep,
      t.settings.generationsToKeepDesc,
      () => s.safeSync.generationsToKeep,
      (v) => (s.safeSync.generationsToKeep = Math.max(1, Math.floor(v))),
    );

    // --- Vault creation profile (ADR-0018) -----------------------------------
    const kdfEl = section("vaultCreation", t.settings.vaultCreationHeading);
    new Setting(kdfEl)
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
    const autoEl = section("autoSync", t.settings.autoSyncHeading);
    new Setting(autoEl)
      .setName(t.settings.syncWhileEditing)
      .setDesc(t.settings.syncWhileEditingDesc)
      .addToggle((tg) =>
        tg.setValue(s.autoSync.enabled).onChange(async (v) => {
          s.autoSync.enabled = v;
          await this.plugin.saveSettings();
          this.plugin.reconfigureScheduler();
        }),
      );
    new Setting(autoEl)
      .setName(t.settings.wifiOnly)
      .setDesc(t.settings.wifiOnlyDesc)
      .addToggle((tg) =>
        tg.setValue(s.autoSync.wifiOnly).onChange(async (v) => {
          s.autoSync.wifiOnly = v;
          await this.plugin.saveSettings();
        }),
      );
    num(
      autoEl,
      t.settings.debounce,
      t.settings.debounceDesc,
      () => s.autoSync.debounceSec,
      (v) => {
        s.autoSync.debounceSec = v;
        // The scheduler captures its timings at construction, so a new number
        // used to take effect only after a lock/unlock or a restart — with
        // nothing on screen saying so (ADR-0047).
        this.plugin.reconfigureScheduler();
      },
    );
    num(
      autoEl,
      t.settings.minInterval,
      t.settings.minIntervalDesc,
      () => s.autoSync.minIntervalSec,
      (v) => {
        s.autoSync.minIntervalSec = v;
        this.plugin.reconfigureScheduler();
      },
    );
    num(
      autoEl,
      t.settings.periodicPull,
      t.settings.periodicPullDesc,
      () => s.autoSync.periodicSec,
      (v) => {
        s.autoSync.periodicSec = v;
        this.plugin.reconfigureScheduler();
      },
    );

    new Setting(devicesEl)
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
