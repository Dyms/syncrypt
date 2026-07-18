// Syncrypt Obsidian plugin — wiring only (RFC-0003): the engine lives in
// @syncrypt/sdk; this file connects Obsidian's surfaces (vault events,
// commands, views, settings) to it.
//
// Triggers (RFC-0004): pull on layout-ready; debounced while-active sync;
// best-effort push on quit; manual "Sync now".

import { Notice, Platform, Plugin, type WorkspaceLeaf } from "obsidian";

import type { SyncEngine, SyncOutcome, SyncReport } from "@syncrypt/sdk";
import {
  CROSS_DEVICE_KDF_PRESET,
  DESKTOP_KDF_PRESET,
  isSyncError,
  openSyncEngine,
} from "@syncrypt/sdk";
import { S3Storage } from "@syncrypt/provider-s3";

import type { DataAdapterLike } from "./adapter-types.js";
import { ConfirmSyncModal } from "./confirm-modal.js";
import { obsidianTransport } from "./obsidian-transport.js";
import { LogBuffer } from "./log-buffer.js";
import { SyncLogView, SYNC_LOG_VIEW_TYPE } from "./log-view.js";
import { migrationPreflight } from "./migration.js";
import { autoSyncAllowed, currentConnection } from "./network.js";
import { AutoSyncScheduler } from "./scheduler.js";
import { DEFAULT_SETTINGS, settingsComplete, withDefaults, type SyncryptSettings } from "./settings.js";
import { SyncryptSettingTab } from "./settings-tab.js";
import { AdapterStateStore } from "./state-store.js";
import { AddDeviceModal, ShareConnectionModal } from "./ticket-modals.js";
import {
  classifyCounts,
  deriveSyncState,
  type SyncCounts,
  type SyncStateView,
} from "./sync-state.js";
import { PassphraseModal } from "./unlock.js";
import { ObsidianVault, SYNC_TRASH_DIR } from "./vault-adapter.js";

export default class SyncryptPlugin extends Plugin {
  settings: SyncryptSettings = DEFAULT_SETTINGS;
  private engine: SyncEngine | null = null;
  private vaultPort: ObsidianVault | null = null;
  private scheduler: AutoSyncScheduler | null = null;
  readonly log = new LogBuffer();
  private statusEl: HTMLElement | null = null;
  private syncing = false;

  // Facts feeding the honest status view (see sync-state.ts).
  private lastOutcome: SyncOutcome | null = null;
  private lastSyncAt: number | null = null;
  private lastError: "network" | "other" | null = null;
  private conflictsCount = 0;
  private counts: SyncCounts | null = null;
  private engineStatus: { baseGeneration: number | null; dirtyFiles: number } | null = null;
  private syncStartLogLength = 0;

  override async onload(): Promise<void> {
    this.settings = withDefaults(await this.loadData(), { mobile: Platform.isMobile });
    await this.saveSettings(); // persist a generated deviceId on first run

    this.addSettingTab(new SyncryptSettingTab(this.app, this));
    this.registerView(SYNC_LOG_VIEW_TYPE, (leaf: WorkspaceLeaf) => new SyncLogView(leaf, this.log));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addEventListener("click", () => void this.syncNow("manual"));
    // Live "syncing (n)" progress from applied-file log events.
    this.log.onChange(() => {
      if (this.syncing) this.renderStatus();
    });
    this.renderStatus();

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
    this.addCommand({
      id: "share-connection",
      name: "Share connection (create a ticket for another device)",
      callback: () => {
        if (!settingsComplete(this.settings)) {
          new Notice("Syncrypt: configure and verify storage first.");
          return;
        }
        new ShareConnectionModal(this.app, this).open();
      },
    });
    this.addCommand({
      id: "add-device",
      name: "Add this device from a ticket",
      callback: () => {
        new AddDeviceModal(this.app, this).open();
      },
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

    // Mobile: best-effort push when the app goes to background (RFC-0004 —
    // no daemon; this is the only "on close" signal Android reliably gives).
    if (Platform.isMobile) {
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden" && this.engine !== null && !this.syncing) {
          void this.engine.push();
        }
      });
    }
  }

  override onunload(): void {
    this.lock();
  }

  // -- status (honesty rule lives in sync-state.ts) --------------------------

  getStatusView(): SyncStateView {
    return deriveSyncState({
      locked: this.engine === null,
      syncing: this.syncing,
      appliedSoFar: this.syncing
        ? this.log.all().filter((l) => l.level === "entry").length - this.syncStartLogLength
        : 0,
      onLine: typeof navigator === "undefined" ? true : navigator.onLine,
      status: this.engineStatus,
      lastOutcome: this.lastOutcome,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      conflicts: this.conflictsCount,
      counts: this.counts,
    });
  }

  private renderStatus(): void {
    const view = this.getStatusView();
    this.statusEl?.setText(view.label);
    this.statusEl?.setAttr("aria-label", view.tooltip);
    this.statusEl?.setAttr("title", view.tooltip);
  }

  /** Refresh status()/counts facts after a sync or unlock (no network I/O). */
  private async refreshFacts(): Promise<void> {
    if (this.engine === null || this.vaultPort === null) return;
    const status = await this.engine.status();
    this.engineStatus = {
      baseGeneration: status.baseGeneration,
      dirtyFiles: status.dirtyFiles,
    };
    const paths: string[] = [];
    for await (const p of this.vaultPort.list()) paths.push(p);
    this.counts = classifyCounts(paths);
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

  /** Used by the Add-device flow: connect with a passphrase already in hand. */
  async connectWithPassphrase(passphrase: string): Promise<void> {
    if (this.isUnlocked()) this.lock(); // settings just changed — rebuild
    await this.unlock(passphrase);
  }

  private async unlock(passphrase: string): Promise<void> {
    try {
      this.statusEl?.setText("Syncrypt: unlocking…");
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
      this.vaultPort = new ObsidianVault(adapter, s.profile);
      this.engine = await openSyncEngine({
        storage,
        vault: this.vaultPort,
        passphrase,
        deviceId: s.deviceId,
        storagePrefix: s.s3.prefix,
        state: new AdapterStateStore(adapter),
        log: this.log,
        safeSync: s.safeSync,
        // ADR-0018: creation profile is an explicit setting; mobile devices
        // refuse vaults above their Argon2id memory budget fail-closed.
        kdfDefaults:
          s.kdfProfile === "desktop-only" ? DESKTOP_KDF_PRESET : CROSS_DEVICE_KDF_PRESET,
        ...(Platform.isMobile ? { affordability: { maxMemoryKiB: 131072 } } : {}),
      });
      this.log.info("Syncrypt unlocked.");
      this.renderStatus();

      // Migration preflight (M6): warn about competing sync systems — never
      // auto-fix (docs/user-guide/migration-from-livesync.md).
      const warnings = await migrationPreflight(adapter);
      for (const w of warnings) this.log.warn(w.message);
      if (warnings.length > 0) {
        new Notice(
          `Syncrypt: ${warnings.length} migration warning(s) — see the sync log before continuing.`,
          10000,
        );
      }

      this.reconfigureScheduler();
      this.registerVaultEvents();
      await this.syncNow("startup"); // the on-open pull (sync = pull+push)
    } catch (e) {
      this.engine = null;
      this.vaultPort = null;
      this.log.warn(`Unlock failed: ${String(e)}`);
      new Notice(`Syncrypt: unlock failed — ${String(e)}`, 8000);
      this.renderStatus();
    }
  }

  lock(): void {
    this.scheduler?.dispose();
    this.scheduler = null;
    this.engine = null; // keys become unreachable; GC clears them
    this.vaultPort = null;
    this.engineStatus = null;
    this.renderStatus();
    this.log.info("Syncrypt locked — keys forgotten.");
  }

  // -- triggers ---------------------------------------------------------------

  private registerVaultEvents(): void {
    const note = (path: string): void => {
      // Our own trash moves and dot-file writes must not retrigger sync.
      if (path.startsWith(SYNC_TRASH_DIR) || path.startsWith(".")) return;
      this.scheduler?.noteChange();
      this.renderStatus(); // dirty state may have changed → "pending"
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

  async syncNow(origin: "manual" | "auto" | "startup"): Promise<void> {
    if (this.engine === null) {
      if (origin === "manual") this.promptUnlock();
      return;
    }
    if (this.syncing) return; // engine also serializes; skip queue pile-up
    if (
      origin === "auto" &&
      !autoSyncAllowed(this.settings.autoSync.wifiOnly, currentConnection())
    ) {
      // RFC-0004 network policy: skip the AUTO sync; the change stays dirty
      // and the next trigger (or a manual sync) picks it up.
      this.statusEl?.setText("Syncrypt: waiting for Wi-Fi");
      return;
    }
    this.syncing = true;
    this.syncStartLogLength = this.log.all().filter((l) => l.level === "entry").length;
    this.scheduler?.noteSyncStarted();
    this.renderStatus();
    try {
      let report = await this.engine.sync();
      if (report.outcome === "needs-confirmation") {
        report = await this.handleConfirmation(report);
      }
      this.lastError = null;
      this.finishReport(report, origin);
    } catch (e) {
      this.lastError =
        isSyncError(e, "StorageTransient") || isSyncError(e, "StorageRateLimited")
          ? "network"
          : "other";
      this.lastSyncAt = Date.now();
      this.log.warn(`Sync failed: ${String(e)}`);
      if (origin !== "auto") new Notice(`Syncrypt: sync failed — ${String(e)}`, 8000);
    } finally {
      this.syncing = false;
      await this.refreshFacts().catch(() => undefined);
      this.renderStatus();
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
    this.lastOutcome = report.outcome;
    this.lastSyncAt = Date.now();
    this.conflictsCount = report.conflicts.length;
    if (report.conflicts.length > 0) {
      new Notice(
        `Syncrypt: ${report.conflicts.length} conflict(s) — both versions kept, see the sync log.`,
        8000,
      );
    }
    if (origin === "manual" && report.outcome === "no-op") {
      new Notice("Syncrypt: already in sync.");
    }
  }

  async activateLogView(): Promise<void> {
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

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings); // never contains the passphrase (ADR-0016)
  }
}
