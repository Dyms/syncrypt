// Syncrypt Obsidian plugin — wiring only (RFC-0003): the engine lives in
// @syncrypt/sdk; this file connects Obsidian's surfaces (vault events,
// commands, views, settings) to it.
//
// Triggers (RFC-0004): pull on layout-ready; debounced while-active sync;
// best-effort push on quit; manual "Sync now".

import { moment, Notice, Platform, Plugin, type EventRef, type WorkspaceLeaf } from "obsidian";

import type { StoragePort, SyncEngine, SyncOutcome, SyncReport } from "@syncrypt/sdk";
import {
  CROSS_DEVICE_KDF_PRESET,
  DESKTOP_KDF_PRESET,
  isSyncError,
  openSyncEngine,
} from "@syncrypt/sdk";
import { S3Storage } from "@syncrypt/provider-s3";
import { WebDavStorage } from "@syncrypt/provider-webdav";

import type { DataAdapterLike } from "./adapter-types.js";
import { ConfirmSyncModal } from "./confirm-modal.js";
import { conflictCopyFor, shortlist } from "./conflict-report.js";
import { AcceptStorageModal } from "./accept-storage-modal.js";
import { ForgetPathsModal } from "./forget-modal.js";
import { formatBytes } from "./format-bytes.js";
import { ReclaimStorageModal } from "./reclaim-modal.js";
import { ReleaseForgottenModal } from "./release-modal.js";
import {
  configPaths,
  DEFAULT_CONFIG_DIR,
  pluginFolderIsOurs,
  type ConfigPaths,
} from "./config-sync.js";
import {
  adoptSharedConfig,
  parseSharedConfig,
  serializeSharedConfig,
  sharedFrom,
} from "./config-sync-file.js";
import {
  describeDetection,
  EN_STRINGS,
  resolveLang,
  stringsFor,
  type LanguageSources,
  type Strings,
} from "./i18n.js";
import { obsidianTransport } from "./obsidian-transport.js";
import { LogBuffer } from "./log-buffer.js";
import { SyncLogView, SYNC_LOG_VIEW_TYPE } from "./log-view.js";
import { migrationPreflight } from "./migration.js";
import { autoSyncAllowed, currentConnection } from "./network.js";
import { AutoSyncScheduler } from "./scheduler.js";
import {
  DEFAULT_SETTINGS,
  settingsComplete,
  storagePrefixOf,
  withDefaults,
  type SyncryptSettings,
} from "./settings.js";
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
import { ObsidianVault } from "./vault-adapter.js";

/** How many conflicting paths the summary log line names before it counts. */
/**
 * How long to wait after the client declines an auto trigger (ADR-0047).
 * Short enough that joining Wi-Fi syncs within a minute; long enough that a
 * long sync is not re-asked constantly.
 */
const RETRY_DECLINED_MS = 60_000;

const CONFLICTS_IN_LOG = 20;

export default class SyncryptPlugin extends Plugin {
  settings: SyncryptSettings = DEFAULT_SETTINGS;
  private engine: SyncEngine | null = null;
  private vaultPort: ObsidianVault | null = null;
  private scheduler: AutoSyncScheduler | null = null;
  readonly log = new LogBuffer();
  private statusEl: HTMLElement | null = null;
  private syncing = false;
  private strings: Strings = EN_STRINGS;

  // Facts feeding the honest status view (see sync-state.ts).
  private lastOutcome: SyncOutcome | null = null;
  /** Bumped by every lock/unload; a sync from an older one reports nothing. */
  private session = 0;
  private vaultEvents: EventRef[] = [];
  private lastSyncAt: number | null = null;
  private lastError: "network" | "other" | null = null;
  private conflictPaths: string[] = [];
  /**
   * Every rule that depends on the config folder's NAME, built from the vault's
   * own `configDir` rather than from an assumption that it is ".obsidian"
   * (ADR-0032). Set in onload, before anything reads a config path.
   */
  private paths: ConfigPaths = configPaths(DEFAULT_CONFIG_DIR);
  private counts: SyncCounts | null = null;
  private engineStatus: { baseGeneration: number | null; dirtyFiles: number } | null = null;
  private syncStartLogLength = 0;

  override async onload(): Promise<void> {
    // FIRST, before any code can read a config path: ask the vault what its
    // config folder is actually called. Obsidian allows renaming it, and
    // assuming ".obsidian" made Config Sync a silent no-op for those vaults
    // (ADR-0032). `configDir` is documented but absent from some stubs and
    // older builds, so the default stands in rather than an empty rule set.
    const configDir: unknown = (this.app.vault as { configDir?: unknown }).configDir;
    // ADR-0034: where we are ACTUALLY installed, not where a BRAT install puts
    // us. `manifest.dir` is vault-relative and may be absent on older clients.
    const ownDir: unknown = (this.manifest as { dir?: unknown }).dir;
    this.paths = configPaths(
      typeof configDir === "string" ? configDir : DEFAULT_CONFIG_DIR,
      typeof ownDir === "string" ? ownDir : undefined,
    );

    const loaded: unknown = await this.loadData();
    this.settings = withDefaults(loaded, { mobile: Platform.isMobile });
    this.applyLanguage();
    // Written only when normalization CHANGED something — a generated device
    // id on first run, a field this version added. It used to be written on
    // every launch, which put the file holding the storage credentials through
    // a rewrite each time Obsidian opened, for nothing (ADR-0047).
    if (JSON.stringify(loaded) !== JSON.stringify(this.settings)) await this.saveSettings();

    this.addSettingTab(new SyncryptSettingTab(this.app, this));
    this.registerView(
      SYNC_LOG_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new SyncLogView(leaf, this.log, () => this.strings),
    );
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addEventListener("click", () => void this.syncNow("manual"));
    // Live "syncing (n)" progress from applied-file log events.
    this.log.onChange(() => {
      if (this.syncing) this.renderStatus();
    });
    this.renderStatus();

    // Command names are fixed at registration time; they follow the language
    // chosen when Obsidian started (a switch takes effect on next launch).
    this.addCommand({
      id: "sync-now",
      name: this.strings.commands.syncNow,
      callback: () => void this.syncNow("manual"),
    });
    this.addCommand({
      id: "unlock",
      name: this.strings.commands.unlock,
      callback: () => { this.promptUnlock(); },
    });
    this.addCommand({
      id: "lock",
      name: this.strings.commands.lock,
      callback: () => { this.lock(); },
    });
    this.addCommand({
      id: "show-log",
      name: this.strings.commands.showLog,
      callback: () => void this.activateLogView(),
    });
    this.addCommand({
      id: "share-connection",
      name: this.strings.commands.shareConnection,
      callback: () => { this.openShareConnection(); },
    });
    this.addCommand({
      id: "add-device",
      name: this.strings.commands.addDevice,
      callback: () => { this.openAddDevice(); },
    });
    this.addCommand({
      id: "rehash-vault",
      name: this.strings.commands.rehashVault,
      callback: () => void this.rehashVault(),
    });
    this.addCommand({
      id: "review-manifest",
      name: this.strings.commands.reviewManifest,
      callback: () => void this.reviewManifest(),
    });
    this.addCommand({
      id: "release-forgotten",
      name: this.strings.commands.releaseForgotten,
      callback: () => void this.releaseForgotten(),
    });
    this.addCommand({
      id: "reclaim-storage",
      name: this.strings.commands.reclaimStorage,
      callback: () => void this.reclaimStorage(),
    });
    this.addCommand({
      id: "accept-storage",
      name: this.strings.commands.acceptStorage,
      callback: () => void this.acceptStorage(),
    });

    // Pull on start (RFC-0004 §Triggers) — once the user unlocks.
    this.app.workspace.onLayoutReady(() => {
      if (settingsComplete(this.settings)) this.promptUnlock();
      else this.log.info(this.strings.log.configureFirst);
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

  // -- language (ADR-0021) ---------------------------------------------------

  /** Current UI strings; modals and the settings tab read through this. */
  t(): Strings {
    return this.strings;
  }

  /**
   * What Obsidian tells us about its interface language. Two sources because
   * neither is guaranteed: the localStorage key is absent for English (and on
   * some installs entirely), and moment's locale has historically lagged.
   */
  private languageSources(): LanguageSources {
    let storage: string | null = null;
    try {
      storage = window.localStorage.getItem("language");
    } catch {
      storage = null; // storage blocked
    }
    let locale: string | null = null;
    try {
      locale = moment.locale();
    } catch {
      locale = null;
    }
    return { storage, moment: locale };
  }

  /** "localStorage: ru, moment: ru → ru" — shown in Settings so a wrong
   *  auto-detection is visible instead of mysterious. */
  languageDiagnostics(): string {
    return describeDetection(this.languageSources());
  }

  /** Re-resolve the language from settings + Obsidian's own choice. */
  applyLanguage(): void {
    this.strings = stringsFor(resolveLang(this.settings.language, this.languageSources()));
  }

  /** Repaint every open surface after a language change. Command names are
   *  registered once by Obsidian, so those follow on the next launch. */
  refreshSurfaces(): void {
    this.renderStatus();
    for (const leaf of this.app.workspace.getLeavesOfType(SYNC_LOG_VIEW_TYPE)) {
      const view: unknown = leaf.view;
      if (view instanceof SyncLogView) view.refresh();
    }
  }

  // -- device enrollment (ADR-0020) ------------------------------------------

  openShareConnection(): void {
    if (!settingsComplete(this.settings)) {
      new Notice(this.strings.notices.configureBeforeSharing);
      return;
    }
    new ShareConnectionModal(this.app, this).open();
  }

  openAddDevice(): void {
    new AddDeviceModal(this.app, this).open();
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
      conflicts: this.conflictPaths,
      now: Date.now(),
      counts: this.counts,
    }, this.strings.status);
  }

  private renderStatus(): void {
    const view = this.getStatusView();
    this.statusEl?.setText(view.label);
    this.statusEl?.setAttr("aria-label", view.tooltip);
    this.statusEl?.setAttr("title", view.tooltip);
  }

  /**
   * Installed third-party plugins, for the config-sync opt-in list (RFC-0008).
   * Reads only manifests; Syncrypt itself is never offered (ADR-0016).
   *
   * The entry's `id` is the FOLDER name, because that is what appears in the
   * paths the sync rules match. Whether an entry is US, however, is decided by
   * the manifest's id — a folder called "syncrypt-1.0.0-beta.9" is still us,
   * and offering it would offer our own storage credentials (ADR-0034).
   */
  async listInstalledPlugins(): Promise<{ id: string; name: string }[]> {
    const adapter = this.app.vault.adapter as unknown as DataAdapterLike;
    const root = `${this.paths.dir}/plugins`;
    if (!(await adapter.exists(root))) return [];
    const { folders } = await adapter.list(root);
    const out: { id: string; name: string }[] = [];
    for (const folder of folders) {
      const id = folder.slice(folder.lastIndexOf("/") + 1);
      // Anything the hard exclusions already cover is not a candidate, whatever
      // it is called — that check knows our real install folder.
      if (this.paths.hardExcluded(`${folder}/data.json`)) continue;
      let name = id;
      let manifestId = "";
      try {
        const raw: unknown = JSON.parse(
          new TextDecoder().decode(new Uint8Array(await adapter.readBinary(`${folder}/manifest.json`))),
        );
        if (typeof raw === "object" && raw !== null) {
          const record = raw as Record<string, unknown>;
          if (typeof record.name === "string" && record.name !== "") name = record.name;
          if (typeof record.id === "string") manifestId = record.id;
        }
      } catch {
        // No readable manifest — show the folder id, still opt-in-able.
      }
      if (pluginFolderIsOurs(id, manifestId)) continue;
      out.push({ id, name });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Count what the CURRENT profile would sync — local only, no keys, no
   * network. Lets the user check a pattern before trusting it.
   */
  async previewProfile(): Promise<{ files: number; notes: number; attachments: number }> {
    const adapter = this.app.vault.adapter as unknown as DataAdapterLike;
    const vault = new ObsidianVault(adapter, this.settings.profile, this.settings.configSync, this.paths);
    const paths: string[] = [];
    for await (const p of vault.list()) paths.push(p);
    const counts = classifyCounts(paths);
    return { files: paths.length, notes: counts.notes, attachments: counts.attachments };
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
      new Notice(this.strings.notices.fillSettingsFirst);
      return;
    }
    new PassphraseModal(
      this.app,
      (passphrase) => this.unlock(passphrase),
      undefined,
      this.strings,
    ).open();
  }

  /** The configured backend, built the same way wherever it is needed. */
  private openStorage(): Promise<StoragePort> {
    const s = this.settings;
    // Both providers go through requestUrl(): it issues a NATIVE request and
    // bypasses webview CORS, which is what made Android work at all
    // (RFC-0006 §Injectable transport). A WebDAV server is no likelier to send
    // permissive CORS headers than an S3 one.
    return s.provider === "webdav"
      ? WebDavStorage.create({
          baseUrl: s.webdav.url,
          username: s.webdav.username,
          password: s.webdav.password,
          transport: obsidianTransport,
        })
      : S3Storage.create({
          endpoint: s.s3.endpoint,
          region: s.s3.region,
          bucket: s.s3.bucket,
          accessKeyId: s.s3.accessKeyId,
          secretAccessKey: s.s3.secretAccessKey,
          forcePathStyle: s.s3.forcePathStyle,
          // So the capability probe writes inside this vault rather than at
          // the bucket root, where a prefix-scoped key cannot reach (ADR-0056).
          vaultPrefix: storagePrefixOf(s),
          transport: obsidianTransport,
        });
  }

  /**
   * Does this passphrase NOT open the vault? (ADR-0048)
   *
   * For "Share connection": a ticket is encrypted with whatever was typed, so
   * a typo produced a ticket that opens into settings nobody can unlock —
   * discovered on the other device, by someone who cannot fix it. Costs one
   * Argon2id derivation on a button the user presses deliberately.
   *
   * `false` on anything that is not a definite "wrong": an unreachable bucket
   * says nothing about the passphrase, and must not block sharing.
   */
  async passphraseIsWrong(passphrase: string): Promise<boolean> {
    try {
      const adapter = this.app.vault.adapter as unknown as DataAdapterLike;
      const engine = await openSyncEngine({
        storage: await this.openStorage(),
        vault: new ObsidianVault(adapter, this.settings.profile, this.settings.configSync, this.paths),
        passphrase,
        deviceId: this.settings.deviceId,
        storagePrefix: storagePrefixOf(this.settings),
        log: this.log,
        ...(Platform.isMobile ? { affordability: { maxMemoryKiB: 131072 } } : {}),
      });
      await engine.verifyAccess();
      return false;
    } catch (e) {
      return isSyncError(e, "CryptoAuthError");
    }
  }

  /** Say how old an accepted ticket is — ADR-0020 promised this and never did. */
  logTicketAge(createdAt: number): void {
    const days = Math.floor((Date.now() / 1000 - createdAt) / 86_400);
    const when = new Date(createdAt * 1000).toLocaleString();
    this.log.info(this.strings.log.ticketAge(when, days));
    if (days >= 7) new Notice(this.strings.notices.ticketOld(days), 10000);
  }

  /** Used by the Add-device flow: connect with a passphrase already in hand. */
  async connectWithPassphrase(passphrase: string): Promise<void> {
    if (this.isUnlocked()) this.lock(); // settings just changed — rebuild
    try {
      await this.unlock(passphrase);
    } catch (e) {
      // No modal is left open here, so the failure needs its own notice.
      new Notice(this.strings.notices.unlockFailed(String(e)), 8000);
    }
  }

  /**
   * Open the vault. THROWS on failure so the caller — normally the passphrase
   * modal — can keep asking instead of the error only reaching the log.
   */
  private async unlock(passphrase: string): Promise<void> {
    try {
      this.statusEl?.setText(this.strings.status.unlocking);
      const s = this.settings;
      // Both providers go through requestUrl(): it issues a NATIVE request and
      // bypasses webview CORS, which is what made Android work at all
      // (RFC-0006 §Injectable transport). A WebDAV server is no likelier to
      // send permissive CORS headers than an S3 one.
      const storage = await this.openStorage();
      const adapter = this.app.vault.adapter as unknown as DataAdapterLike;
      this.vaultPort = new ObsidianVault(adapter, s.profile, s.configSync, this.paths);
      this.engine = await openSyncEngine({
        storage,
        vault: this.vaultPort,
        passphrase,
        deviceId: s.deviceId,
        // ADR-0036: recorded in what we publish, compared against what we read.
        clientVersion: this.manifest.version,
        storagePrefix: storagePrefixOf(s),
        state: new AdapterStateStore(adapter, this.paths.stateFile),
        log: this.log,
        safeSync: s.safeSync,
        // ADR-0018: creation profile is an explicit setting; mobile devices
        // refuse vaults above their Argon2id memory budget fail-closed.
        kdfDefaults:
          s.kdfProfile === "desktop-only" ? DESKTOP_KDF_PRESET : CROSS_DEVICE_KDF_PRESET,
        ...(Platform.isMobile ? { affordability: { maxMemoryKiB: 131072 } } : {}),
      });
      // Prove the keys actually open this vault BEFORE reporting success:
      // reads and decrypts the published manifest, no local scan (RFC-0007).
      // A wrong passphrase fails here, at the modal, not halfway into the
      // first sync.
      //
      // A transient network failure is NOT a reason to refuse the vault: the
      // notes are local, editing must keep working, and the next sync will
      // verify the keys anyway. Only a definitive answer blocks the unlock.
      try {
        const vault = await this.engine.verifyAccess();
        if (vault === null) this.log.info(this.strings.log.freshVault);
      } catch (e) {
        if (
          !isSyncError(e, "StorageTransient") &&
          !isSyncError(e, "StorageRateLimited")
        ) {
          throw e;
        }
        this.log.warn(this.strings.log.verifyOffline);
      }

      this.log.info(this.strings.log.unlocked);
      this.renderStatus();

      // Migration preflight (M6): warn about competing sync systems — never
      // auto-fix (docs/user-guide/migration-from-livesync.md).
      // Warnings only, and it must never cost an unlock the vault already
      // proved open: `verifyAccess` succeeded above, so an adapter hiccup in a
      // check ABOUT OTHER PLUGINS is not a reason to tear the engine down
      // (ADR-0046).
      const warnings = await migrationPreflight(adapter, this.strings, this.paths).catch(
        () => [],
      );
      for (const w of warnings) this.log.warn(w.message);
      if (warnings.length > 0) {
        new Notice(this.strings.notices.migrationWarnings(warnings.length), 10000);
      }

      this.reconfigureScheduler();
      this.registerVaultEvents();
      // The vault is OPEN at this point — verifyAccess already proved the keys
      // work — so return control now and let the on-open pull run in the
      // background. Awaiting it here would hold the passphrase dialog on
      // "Checking…" for the length of a full sync (minutes on a large vault)
      // while the log already says "unlocked". Failures surface as the usual
      // status + notice; syncNow() never throws.
      void this.syncNow("startup"); // the on-open pull (sync = pull+push)
    } catch (e) {
      this.engine = null;
      this.vaultPort = null;
      this.scheduler?.dispose();
      this.scheduler = null;
      this.log.warn(this.strings.log.unlockFailed(String(e)));
      this.renderStatus();
      throw e; // the modal explains it; see PassphraseModal
    }
  }

  lock(): void {
    this.scheduler?.dispose();
    this.scheduler = null;
    this.engine = null; // keys become unreachable; GC clears them
    this.vaultPort = null;
    this.engineStatus = null;
    for (const ref of this.vaultEvents) this.app.vault.offref(ref);
    this.vaultEvents = [];
    // A sync may still be running against the engine we just dropped. It can
    // finish — nothing it does is unsafe — but it belongs to a session that no
    // longer exists, so its report must not become this session's status and
    // must not unblock the next unlock's startup pull (ADR-0048).
    this.session++;
    this.syncing = false;
    this.renderStatus();
    this.log.info(this.strings.log.locked);
  }

  // -- triggers ---------------------------------------------------------------

  private registerVaultEvents(): void {
    if (this.vaultEvents.length > 0) return; // already listening (ADR-0048)
    const note = (path: string): void => {
      // Our own trash moves and dot-file writes must not retrigger sync.
      if (path.startsWith(this.paths.syncTrash) || path.startsWith(".")) return;
      this.scheduler?.noteChange();
      this.renderStatus(); // dirty state may have changed → "pending"
    };
    // Kept so `lock()` can detach them. `registerEvent` alone only detaches on
    // UNLOAD, so every lock→unlock cycle used to add another set and every
    // keystroke batch ran `note()` once more (ADR-0048).
    this.vaultEvents = [
      this.app.vault.on("modify", (f) => { note(f.path); }),
      this.app.vault.on("create", (f) => { note(f.path); }),
      this.app.vault.on("delete", (f) => { note(f.path); }),
      this.app.vault.on("rename", (f, oldPath) => { note(f.path); note(oldPath); }),
    ];
    for (const ref of this.vaultEvents) this.registerEvent(ref);
  }

  reconfigureScheduler(): void {
    this.scheduler?.dispose();
    this.scheduler = null;
    if (!this.isUnlocked() || !this.settings.autoSync.enabled) return;
    this.scheduler = new AutoSyncScheduler(() => void this.syncNow("auto"), {
      debounceMs: this.settings.autoSync.debounceSec * 1000,
      minIntervalMs: this.settings.autoSync.minIntervalSec * 1000,
      retryMs: RETRY_DECLINED_MS,
      periodicMs: this.settings.autoSync.periodicSec * 1000,
    });
    this.scheduler.armPeriodic();
  }

  // -- sync -----------------------------------------------------------------

  async syncNow(origin: "manual" | "auto" | "startup"): Promise<void> {
    if (this.engine === null) {
      if (origin === "manual") this.promptUnlock();
      return;
    }
    if (this.syncing) {
      // Engine also serializes; skip the queue pile-up — but come back, or
      // this edit waits for an unrelated one to happen (ADR-0047).
      if (origin === "auto") this.scheduler?.retryLater();
      return;
    }
    if (
      origin === "auto" &&
      !autoSyncAllowed(this.settings.autoSync.wifiOnly, currentConnection())
    ) {
      // RFC-0004 network policy: skip the AUTO sync — and ask again later.
      // "The next trigger picks it up" was only true if the user happened to
      // edit something else; a phone that went quiet on cellular never synced
      // those edits at all, however long it later sat on Wi-Fi.
      this.statusEl?.setText(this.strings.status.waitingForWifi);
      this.scheduler?.retryLater();
      return;
    }
    const session = this.session;
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
      if (session === this.session) this.finishReport(report, origin);
    } catch (e) {
      this.lastError =
        session === this.session
          ? isSyncError(e, "StorageTransient") || isSyncError(e, "StorageRateLimited")
            ? "network"
            : "other"
          : this.lastError;
      if (session === this.session) this.lastSyncAt = Date.now();
      this.log.warn(this.strings.log.syncFailed(String(e)));
      if (origin !== "auto") new Notice(this.strings.notices.syncFailed(String(e)), 8000);
    } finally {
      // Still inside the `syncing` guard: adopting a shared profile changes
      // what this device syncs, so it must not race the next sync (ADR-0024).
      if (session === this.session) {
        await this.reconcileSharedConfig().catch(() => undefined);
        this.syncing = false;
        await this.refreshFacts().catch(() => undefined);
      }
      this.renderStatus();
    }
  }

  // -- shared Obsidian-settings profile (ADR-0024) ---------------------------

  /**
   * After every sync: adopt the vault's shared config-sync profile, or publish
   * ours if the vault has none yet. Inert while config sync is off — a device
   * that has not opted in is never reconfigured from elsewhere.
   */
  private async reconcileSharedConfig(): Promise<void> {
    if (!this.settings.configSync.enabled) return;
    const adapter = this.app.vault.adapter as unknown as DataAdapterLike;
    let text: string | null = null;
    try {
      if (await adapter.exists(this.paths.sharedProfile)) {
        text = new TextDecoder().decode(await adapter.readBinary(this.paths.sharedProfile));
      }
    } catch {
      return; // unreadable right now; the next sync tries again
    }
    if (text === null) {
      // Nobody has published one. Ours becomes the vault's, and travels on the
      // next sync. Two devices doing this at once agree by construction: the
      // file is canonical, so identical settings are identical bytes.
      await this.publishSharedConfig();
      return;
    }
    const shared = parseSharedConfig(text);
    if (shared === null) {
      this.log.warn(this.strings.log.configSyncUnreadable);
      return;
    }
    const result = adoptSharedConfig(this.settings.configSync, shared);
    if (!result.changed) return;
    await this.saveSettings();
    const summary = [
      result.enabledCategories.length > 0 ? `+${String(result.enabledCategories.length)}` : "",
      result.disabledCategories.length > 0 ? `-${String(result.disabledCategories.length)}` : "",
      result.addedPlugins.length > 0 ? `+${result.addedPlugins.join(", ")}` : "",
      result.removedPlugins.length > 0 ? `-${result.removedPlugins.join(", ")}` : "",
    ]
      .filter((part) => part !== "")
      .join(" ");
    this.log.info(this.strings.log.configSyncAdopted(summary));
    new Notice(this.strings.notices.configSyncAdopted, 6000);
    // RFC-0008 safety rail 1 does not stop applying at the user's other
    // device's request, but it does say so out loud.
    if (result.addedSecretBearing.length > 0) {
      new Notice(
        this.strings.notices.configSyncSecretPlugins(result.addedSecretBearing.join(", ")),
        12000,
      );
    }
  }

  /**
   * Write this device's config-sync profile into the vault's shared file.
   * Called when the user changes a config-sync setting, and when no shared
   * file exists yet. An identical file is left alone — rewriting it would
   * churn the mtime and cost a pointless upload.
   */
  async publishSharedConfig(): Promise<void> {
    if (!this.settings.configSync.enabled) return;
    const adapter = this.app.vault.adapter as unknown as DataAdapterLike;
    const text = serializeSharedConfig(sharedFrom(this.settings.configSync));
    try {
      if (await adapter.exists(this.paths.sharedProfile)) {
        const current = new TextDecoder().decode(
          await adapter.readBinary(this.paths.sharedProfile),
        );
        if (current === text) return;
      }
      const bytes = new TextEncoder().encode(text);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      await adapter.writeBinary(this.paths.sharedProfile, buffer);
      this.log.info(this.strings.log.configSyncPublished);
    } catch {
      // Not being able to write it is not worth failing anything over: the
      // settings are correct locally, and the next change tries again.
    }
  }

  private async handleConfirmation(original: SyncReport): Promise<SyncReport> {
    if (this.engine === null) return original;
    const plan = await this.engine.dryRun();
    const approved = await new Promise<boolean>((resolve) => {
      new ConfirmSyncModal(this.app, plan, resolve, this.strings).open();
    });
    if (!approved) {
      this.log.info(this.strings.log.bulkCancelled);
      return original;
    }
    return this.engine.confirmAndApply(plan);
  }

  private finishReport(report: SyncReport, origin: string): void {
    this.lastOutcome = report.outcome;
    this.lastSyncAt = Date.now();
    this.conflictPaths = [...report.conflicts];
    if (report.conflicts.length > 0) {
      // Naming the file is the whole point: "1 conflict — merge them" with no
      // path is advice the user cannot act on.
      new Notice(
        report.conflicts.length === 1 && report.conflicts[0] !== undefined
          ? this.strings.notices.conflictOne(report.conflicts[0])
          : this.strings.notices.conflicts(report.conflicts.length),
        8000,
      );
      // One summary line that survives scrolling, next to the per-file entries.
      const { shown, more } = shortlist(report.conflicts, CONFLICTS_IN_LOG);
      this.log.warn(this.strings.log.conflictsFound(shown, more));
    }
    if (report.conflicts.includes(this.paths.sharedProfile)) {
      // A conflicted copy of the shared profile is not itself syncable, so it
      // would otherwise sit in `.obsidian` unmentioned (ADR-0024) — and
      // `.obsidian` is not in Obsidian's own file list, so an unnamed copy is
      // effectively invisible. Name both paths and say what to do with them.
      this.log.warn(
        this.strings.log.configSyncConflicted(
          this.paths.sharedProfile,
          conflictCopyFor(report, this.paths.sharedProfile),
        ),
      );
    }
    if (origin === "manual" && report.outcome === "no-op") {
      new Notice(this.strings.notices.alreadyInSync);
    }
  }

  /**
   * Forget every cached content hash (ADR-0023). For the case the cache cannot
   * see: a tool that restored files with their original mtimes and sizes, so
   * "unchanged" is a lie. Costs one full re-hash and nothing else.
   */
  async rehashVault(): Promise<void> {
    if (this.engine === null) {
      this.promptUnlock();
      return;
    }
    await this.engine.forgetHashCache();
    this.log.info(this.strings.log.hashCacheCleared);
    new Notice(this.strings.notices.hashCacheCleared, 6000);
    await this.syncNow("manual");
  }

  /**
   * Manifest cleanup (ADR-0027): show what this device does not carry, let the
   * user pick, forget the picks. Never automatic — this device cannot see the
   * other devices' profiles, so the judgement is the user's.
   */
  async reviewManifest(): Promise<void> {
    if (this.engine === null) {
      this.promptUnlock();
      return;
    }
    const candidates = await this.engine.listUncarried();
    if (candidates.length === 0) {
      new Notice(this.strings.forgetModal.noneFound, 6000);
      return;
    }
    const engine = this.engine;
    const chosen = await new Promise<string[]>((resolve) => {
      new ForgetPathsModal(this.app, candidates, resolve, this.strings).open();
    });
    if (chosen.length === 0) return;
    const result = await engine.forgetPaths(chosen);
    if (result.generation === null) {
      new Notice(this.strings.forgetModal.raced, 8000);
      return;
    }
    new Notice(this.strings.forgetModal.done(result.forgotten.length), 8000);
    await this.refreshFacts().catch(() => undefined);
    this.renderStatus();
  }

  /**
   * Accept a storage that went backwards (ADR-0038) — the escape hatch for a
   * bucket restored from a backup.
   *
   * The rollback is re-checked HERE rather than remembered from the sync that
   * refused: a stale flag would let the command run against a storage that has
   * since caught up, and the check costs one manifest read.
   */
  async acceptStorage(): Promise<void> {
    if (this.engine === null) {
      this.promptUnlock();
      return;
    }
    const engine = this.engine;
    const { baseGeneration } = await engine.status();
    // No manifest at all is generation 0 — a wiped bucket is a rollback too.
    const remoteGeneration = (await engine.verifyAccess())?.generation ?? 0;
    if (baseGeneration === null || remoteGeneration >= baseGeneration) {
      new Notice(this.strings.notices.notRolledBack, 6000);
      return;
    }
    const approved = await new Promise<boolean>((resolve) => {
      new AcceptStorageModal(
        this.app,
        remoteGeneration,
        baseGeneration,
        resolve,
        this.strings,
      ).open();
    });
    if (!approved) return;
    await engine.forgetBase();
    new Notice(this.strings.notices.storageAccepted, 8000);
    await this.syncNow("manual");
  }

  /**
   * Release the copies kept for forgotten entries (ADR-0055).
   *
   * Its own command, deliberately: forgetting is reversible precisely because
   * this step is separate, and folding it into the reclaim dialog would make
   * one confirmation stand for two very different decisions.
   */
  async releaseForgotten(): Promise<void> {
    if (this.engine === null) {
      this.promptUnlock();
      return;
    }
    const engine = this.engine;
    const kept = (await engine.status()).forgottenObjects;
    const approved = await new Promise<boolean>((resolve) => {
      new ReleaseForgottenModal(this.app, kept, resolve, this.strings).open();
    });
    if (!approved || kept === 0) return;
    const result = await engine.releaseForgotten();
    if (result.generation === null) {
      new Notice(this.strings.releaseModal.raced, 8000);
      return;
    }
    new Notice(this.strings.releaseModal.done(result.released), 8000);
    await this.refreshFacts().catch(() => undefined);
    this.renderStatus();
  }

  /**
   * Reclaim storage (ADR-0030): preview, confirm, sweep. The one operation
   * nothing undoes, so it is a command the user runs deliberately, never a
   * side effect of syncing — and the plan shown is recomputed inside the
   * engine before anything is deleted, never executed as previewed.
   */
  async reclaimStorage(): Promise<void> {
    if (this.engine === null) {
      this.promptUnlock();
      return;
    }
    const engine = this.engine;
    const plan = await engine.previewReclaim();
    const approved = await new Promise<boolean>((resolve) => {
      new ReclaimStorageModal(this.app, plan, resolve, this.strings).open();
    });
    // Nothing ripe and nothing to prune is the NORMAL first outcome: there was
    // no decision to make, so closing the dialog is not a "no". Persist the
    // mark, or the grace window would never start for a user who only looks.
    // When there WAS something to approve, cancel means cancel — running the
    // operation anyway would prune the generations they just declined.
    const actionable = plan.sweep.length > 0 || plan.prunedManifests.length > 0;
    if (!approved) {
      if (!actionable && plan.waiting > 0 && plan.ripeAt !== null) {
        await engine.reclaimStorage();
        new Notice(
          this.strings.reclaimModal.noneYet(new Date(plan.ripeAt * 1000).toLocaleString()),
          8000,
        );
      }
      return;
    }
    const result = await engine.reclaimStorage();
    new Notice(
      this.strings.reclaimModal.done(result.deleted.length, formatBytes(result.bytesFreed)),
      8000,
    );
    await this.refreshFacts().catch(() => undefined);
    this.renderStatus();
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
