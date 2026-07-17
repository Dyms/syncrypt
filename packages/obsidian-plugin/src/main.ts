// Syncrypt Obsidian plugin — wiring only (RFC-0003): the engine lives in
// @syncrypt/sdk; this file connects Obsidian's surfaces (vault events,
// commands, views, settings) to it.
//
// Triggers (RFC-0004): pull on layout-ready; debounced while-active sync;
// best-effort push on quit; manual "Sync now".

import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";

import type { SyncEngine, SyncReport } from "@syncrypt/sdk";
import { openSyncEngine } from "@syncrypt/sdk";
import { S3Storage } from "@syncrypt/provider-s3";

import type { DataAdapterLike } from "./adapter-types.js";
import { ConfirmSyncModal } from "./confirm-modal.js";
import { obsidianTransport } from "./obsidian-transport.js";
import { LogBuffer } from "./log-buffer.js";
import { SyncLogView, SYNC_LOG_VIEW_TYPE } from "./log-view.js";
import { AutoSyncScheduler } from "./scheduler.js";
import { DEFAULT_SETTINGS, settingsComplete, withDefaults, type SyncryptSettings } from "./settings.js";
import { SyncryptSettingTab } from "./settings-tab.js";
import { AdapterStateStore } from "./state-store.js";
import { PassphraseModal } from "./unlock.js";
import { ObsidianVault, SYNC_TRASH_DIR } from "./vault-adapter.js";

export default class SyncryptPlugin extends Plugin {
  settings: SyncryptSettings = DEFAULT_SETTINGS;
  private engine: SyncEngine | null = null;
  private scheduler: AutoSyncScheduler | null = null;
  private readonly log = new LogBuffer();
  private statusEl: HTMLElement | null = null;
  private syncing = false;

  override async onload(): Promise<void> {
    this.settings = withDefaults(await this.loadData());
    await this.saveSettings(); // persist a generated deviceId on first run

    this.addSettingTab(new SyncryptSettingTab(this.app, this));
    this.registerView(SYNC_LOG_VIEW_TYPE, (leaf: WorkspaceLeaf) => new SyncLogView(leaf, this.log));
    this.statusEl = this.addStatusBarItem();
    this.setStatus("locked");

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow("manual"),
    });
    this.addCommand({
      id: "unlock",
      name: "Unlock (enter passphrase)",
      callback: () => { this.promptUnlock(); },
    });
    this.addCommand({
      id: "lock",
      name: "Lock (forget keys)",
      callback: () => { this.lock(); },
    });
    this.addCommand({
      id: "show-log",
      name: "Show sync log",
      callback: () => void this.activateLogView(),
    });

    // Pull on start (RFC-0004 §Triggers) — once the user unlocks.
    this.app.workspace.onLayoutReady(() => {
      if (settingsComplete(this.settings)) this.promptUnlock();
      else this.log.info("Syncrypt: configure storage in Settings, then unlock.");
    });

    // Best-effort push on quit — never blocks shutdown (RFC-0004).
    this.registerDomEvent(window, "beforeunload", () => {
      if (this.engine !== null && !this.syncing) void this.engine.push();
    });
  }

  override onunload(): void {
    this.lock();
  }

  // -- unlock / lock (ADR-0016: keys are session-only) -----------------------

  isUnlocked(): boolean {
    return this.engine !== null;
  }

  promptUnlock(): void {
    if (this.isUnlocked()) return;
    if (!settingsComplete(this.settings)) {
      new Notice("Syncrypt: fill in the storage settings first.");
      return;
    }
    new PassphraseModal(this.app, (passphrase) => void this.unlock(passphrase)).open();
  }

  private async unlock(passphrase: string): Promise<void> {
    try {
      this.setStatus("unlocking…");
      const s = this.settings;
      const storage = await S3Storage.create({
        endpoint: s.s3.endpoint,
        region: s.s3.region,
        bucket: s.s3.bucket,
        accessKeyId: s.s3.accessKeyId,
        secretAccessKey: s.s3.secretAccessKey,
        forcePathStyle: s.s3.forcePathStyle,
        // requestUrl() bypasses webview CORS (RFC-0006 §Injectable transport).
        transport: obsidianTransport,
      });
      const adapter = this.app.vault.adapter as unknown as DataAdapterLike;
      this.engine = await openSyncEngine({
        storage,
        vault: new ObsidianVault(adapter, s.profile),
        passphrase,
        deviceId: s.deviceId,
        storagePrefix: s.s3.prefix,
        state: new AdapterStateStore(adapter),
        log: this.log,
        safeSync: s.safeSync,
      });
      this.log.info("Syncrypt unlocked.");
      this.setStatus("idle");
      this.reconfigureScheduler();
      this.registerVaultEvents();
      await this.syncNow("startup"); // the on-open pull (sync = pull+push)
    } catch (e) {
      this.engine = null;
      this.setStatus("locked");
      this.log.warn(`Unlock failed: ${String(e)}`);
      new Notice(`Syncrypt: unlock failed — ${String(e)}`, 8000);
    }
  }

  lock(): void {
    this.scheduler?.dispose();
    this.scheduler = null;
    this.engine = null; // keys become unreachable; GC clears them
    this.setStatus("locked");
    this.log.info("Syncrypt locked — keys forgotten.");
  }

  // -- triggers ---------------------------------------------------------------

  private registerVaultEvents(): void {
    const note = (path: string): void => {
      // Our own trash moves and dot-file writes must not retrigger sync.
      if (path.startsWith(SYNC_TRASH_DIR) || path.startsWith(".")) return;
      this.scheduler?.noteChange();
    };
    this.registerEvent(this.app.vault.on("modify", (f) => { note(f.path); }));
    this.registerEvent(this.app.vault.on("create", (f) => { note(f.path); }));
    this.registerEvent(this.app.vault.on("delete", (f) => { note(f.path); }));
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        note(f.path);
        note(oldPath);
      }),
    );
  }

  reconfigureScheduler(): void {
    this.scheduler?.dispose();
    this.scheduler = null;
    if (!this.isUnlocked() || !this.settings.autoSync.enabled) return;
    this.scheduler = new AutoSyncScheduler(() => void this.syncNow("auto"), {
      debounceMs: this.settings.autoSync.debounceSec * 1000,
      minIntervalMs: this.settings.autoSync.minIntervalSec * 1000,
    });
  }

  // -- sync -----------------------------------------------------------------

  private async syncNow(origin: "manual" | "auto" | "startup"): Promise<void> {
    if (this.engine === null) {
      if (origin === "manual") this.promptUnlock();
      return;
    }
    if (this.syncing) return; // engine also serializes; skip queue pile-up
    this.syncing = true;
    this.scheduler?.noteSyncStarted();
    this.setStatus("syncing…");
    try {
      let report = await this.engine.sync();
      if (report.outcome === "needs-confirmation") {
        report = await this.handleConfirmation(report);
      }
      this.finishReport(report, origin);
    } catch (e) {
      this.setStatus("error");
      this.log.warn(`Sync failed: ${String(e)}`);
      if (origin !== "auto") new Notice(`Syncrypt: sync failed — ${String(e)}`, 8000);
    } finally {
      this.syncing = false;
    }
  }

  private async handleConfirmation(original: SyncReport): Promise<SyncReport> {
    if (this.engine === null) return original;
    const plan = await this.engine.dryRun();
    const approved = await new Promise<boolean>((resolve) => {
      new ConfirmSyncModal(this.app, plan, resolve).open();
    });
    if (!approved) {
      this.log.info("Bulk change NOT applied — cancelled by you.");
      return original;
    }
    return this.engine.confirmAndApply(plan);
  }

  private finishReport(report: SyncReport, origin: string): void {
    if (report.conflicts.length > 0) {
      this.setStatus(`conflicts: ${report.conflicts.length}`);
      new Notice(
        `Syncrypt: ${report.conflicts.length} conflict(s) — both versions kept, see the sync log.`,
        8000,
      );
    } else if (report.outcome === "needs-confirmation") {
      this.setStatus("waiting for confirmation");
    } else {
      this.setStatus(
        report.entries.length > 0 ? `synced ${report.entries.length} changes` : "idle",
      );
    }
    if (origin === "manual" && report.outcome === "no-op") {
      new Notice("Syncrypt: already in sync.");
    }
  }

  private async activateLogView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SYNC_LOG_VIEW_TYPE)[0];
    if (existing !== undefined) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf !== null) {
      await leaf.setViewState({ type: SYNC_LOG_VIEW_TYPE, active: true });
    }
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(`Syncrypt: ${text}`);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings); // never contains the passphrase (ADR-0016)
  }
}
