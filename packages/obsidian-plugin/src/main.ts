// Syncrypt Obsidian plugin — wiring only (RFC-0003): the engine lives in
// @syncrypt/sdk; this file connects Obsidian's surfaces (vault events,
// commands, views, settings) to it.
//
// Triggers (RFC-0004): pull on layout-ready; debounced while-active sync;
// best-effort push on quit; manual "Sync now".

import {
  moment,
  Notice,
  Platform,
  Plugin,
  type App,
  type EventRef,
  type WorkspaceLeaf,
} from "obsidian";

import type { StoragePort, SyncEngine, SyncOutcome, SyncReport } from "@syncrypt/sdk";
import {
  CROSS_DEVICE_KDF_PRESET,
  DESKTOP_KDF_PRESET,
  isSyncError,
  MOBILE_MEMORY_BUDGET_KIB,
  openSyncEngine,
  SyncError,
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
  describeStorageLocation,
  foreignProvider,
  generateDeviceId,
  settingsComplete,
  storageLocationTag,
  storagePrefixOf,
  unknownKeys,
  withDefaults,
  type SyncryptSettings,
} from "./settings.js";
import { SyncryptSettingTab } from "./settings-tab.js";
import { DEVICE_ID_KEY, resolveDeviceIdentity, type InstallStore } from "./device-identity.js";
import { AdapterStateStore, adoptLegacyState } from "./state-store.js";
import { AddDeviceModal, ShareConnectionModal } from "./ticket-modals.js";
import {
  classifyCounts,
  deriveSyncState,
  type SyncCounts,
  type SyncStateView,
} from "./sync-state.js";
import { PassphraseModal } from "./unlock.js";
import { UncheckablePassphrase } from "./unlock-flow.js";
import {
  commandFailureMessage,
  LocationChanged,
  prefixHasEmptySegment,
  PreviousSessionBusy,
  SettingsReadOnly,
  syncFailureMessage,
  unlockFailureMessage,
  UnusablePrefix,
} from "./unlock-error.js";
import { passphraseIsDefinitelyWrong } from "./passphrase-check.js";
import { ObsidianVault } from "./vault-adapter.js";

/**
 * How long an unlock waits for what the previous session left running before
 * saying so instead (ADR-0081, Q4). The abort is seen between requests; a
 * healthy one stops well inside this.
 */
const PREVIOUS_SESSION_WAIT_MS = 1_000;

/** How many conflicting paths the summary log line names before it counts. */
/**
 * How long to wait after the client declines an auto trigger (ADR-0047).
 * Short enough that joining Wi-Fi syncs within a minute; long enough that a
 * long sync is not re-asked constantly.
 */
const RETRY_DECLINED_MS = 60_000;
/** Safe Sync dialogs in a row for one sync before giving up on a moving plan (ADR-0073). */
const MAX_CONFIRMATION_ROUNDS = 2;
/** How long after the last edit the status re-reads the real dirty count (ADR-0073). */
const FACTS_SETTLE_MS = 2_000;

const CONFLICTS_IN_LOG = 20;

export default class SyncryptPlugin extends Plugin {
  // A copy, never the shared defaults object: settings are replaced IN PLACE
  // (replaceSettings), and mutating DEFAULT_SETTINGS would change every
  // default after it.
  settings: SyncryptSettings = structuredClone(DEFAULT_SETTINGS);
  private settingTab: SyncryptSettingTab | null = null;
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
  /**
   * The sync in flight, so `lock()` can stop it and the next `unlock()` can
   * wait for it (ADR-0066). ADR-0048 let an orphaned sync "finish harmlessly";
   * it did not: after Lock → Unlock two engines ran on one vault, and the
   * second one's downloads met the first one's writes as conflicts.
   */
  private running: { abort: AbortController; done: Promise<void> } | null = null;
  /**
   * Maintenance commands in flight — reclaim, release, forget, accept — held
   * like `running`: Lock aborts them and the next unlock waits for them
   * (ADR-0081, post-fix Q7). They used to run with no signal at all.
   */
  private readonly chores = new Set<{ abort: AbortController; done: Promise<void> }>();
  /**
   * Unlocked while the storage was unreachable, so the passphrase was never
   * checked (ADR-0081, post-fix Q3). The first operation that can publish
   * checks it first, and asks for it again when there is nothing to check
   * against — ADR-0078's rule, which a network blip used to skip.
   */
  private unverified = false;
  /** Bumped by every storage-settings edit; an unlock that saw an older one is refused (Q6). */
  private storageEpoch = 0;
  /** A ticket's settings being written; an unlock waits for it (ADR-0082). */
  private settingsSettled: Promise<unknown> = Promise.resolve();
  /** Aborts the session engine's pending storage READS on Lock (ADR-0085). */
  private sessionReads: AbortController | null = null;
  /** Set by onunload: nothing opens an engine on an unloaded instance (Q8). */
  private unloaded = false;
  /** Dialogs waiting on a decision; `lock()` closes them as "no" (ADR-0066). */
  private readonly openModals = new Set<{ close(): void }>();
  /**
   * A sync that started with config sync ON has completed its pull in this
   * session. Only then does "no shared profile on disk" mean "the vault has
   * none" (ADR-0068): after a failed, cancelled or declined pull it means
   * nothing, and publishing then put this device's defaults over the vault's.
   */
  private configPulled = false;
  /** data.json's top-level fields this build does not know, written back as-is (ADR-0075). */
  private extraData: Record<string, unknown> = {};
  /** A provider only a newer build knows: settings read-only, no unlock (ADR-0075). */
  private foreignProvider: string | null = null;
  /** Pending refreshFactsSoon() (ADR-0073). */
  private factsTimer: ReturnType<typeof setTimeout> | null = null;
  /** A profile or Safe Sync edit arrived during a sync; applied after it (ADR-0072). */
  private liveSettingsPending = false;
  /** The one passphrase dialog, so a second cannot race the first (B11). */
  private unlockModal: PassphraseModal | null = null;
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
    // The device ID belongs to this installation, not to the folder (ADR-0069).
    // withDefaults has already made one up if data.json had none.
    const fromData = this.settings.deviceId;
    const identity = resolveDeviceIdentity(
      fromData,
      this.settings.deviceIdInstalled,
      installStore(this.app),
      generateDeviceId,
    );
    this.settings.deviceId = identity.deviceId;
    this.settings.deviceIdInstalled = identity.installed;
    if (identity.copied) {
      this.log.info(this.strings.log.deviceCopied(fromData, identity.deviceId));
      new Notice(this.strings.notices.deviceCopied, 12000);
    }
    // Written only when normalization CHANGED something — a generated device
    // id on first run, a field this version added. It used to be written on
    // every launch, which put the file holding the storage credentials through
    // a rewrite each time Obsidian opened, for nothing (ADR-0047).
    // A newer build's data.json (ADR-0075): its fields are kept on every write,
    // and if it names a provider this build does not know, nothing is written
    // and nothing connects — falling back to S3 would reach the old bucket.
    this.extraData = unknownKeys(loaded);
    this.foreignProvider = foreignProvider(loaded);
    if (this.foreignProvider !== null) {
      this.log.warn(this.strings.log.newerData(this.foreignProvider));
      new Notice(this.strings.notices.newerData(this.foreignProvider), 15000);
    } else if (JSON.stringify(loaded) !== JSON.stringify({ ...this.extraData, ...this.settings })) {
      await this.saveSettings();
    }
    // A sync-state.json from before ADR-0065 describes the location the
    // settings named WHEN IT WAS WRITTEN — the settings as loaded, before
    // anything in this session can change them. Handed over at the first
    // unlock instead, it went to wherever the settings pointed by then: update,
    // then "Add device" with a ticket for another vault, and vault A's base
    // became vault B's (post-fix review, Q1; ADR-0081). Not under a newer
    // build's settings (ADR-0075): their location is not one this build reads.
    if (this.foreignProvider === null) {
      const adapter = this.app.vault.adapter as unknown as DataAdapterLike;
      await adoptLegacyState(
        adapter,
        this.paths.stateFile,
        this.paths.stateFileFor(storageLocationTag(this.settings)),
      ).catch((e: unknown) => {
        this.log.warn(this.strings.log.syncFailed(String(e)));
      });
    }

    this.settingTab = new SyncryptSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
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
    // Through syncNow like every other sync: held in `running`, so Lock stops
    // it and the next unlock waits for it (ADR-0081, post-fix Q5). A bare
    // `engine.push()` here ran outside the lock boundary ADR-0066 drew.
    this.registerDomEvent(window, "beforeunload", () => {
      void this.syncNow("background");
    });

    // Mobile: best-effort push when the app goes to background (RFC-0004 —
    // no daemon; this is the only "on close" signal Android reliably gives).
    if (Platform.isMobile) {
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") void this.syncNow("background");
      });
    }
  }

  override onunload(): void {
    // The passphrase dialog is not one of `openModals`: closed here, or it
    // outlives the instance and an answer opens an engine no unload will
    // ever stop (ADR-0081, post-fix Q8). An unlock already deriving keys
    // checks `unloaded` before it takes the engine.
    this.unloaded = true;
    // A profile edit still in its field is the person's edit: saved, not
    // dropped with the tab (ADR-0083). Best effort — a quit may not wait.
    void this.settingTab?.commitProfileEdits();
    this.unlockModal?.dismiss();
    this.unlockModal = null;
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
        ? this.log.entryCount() - this.syncStartLogLength
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
  /**
   * The real dirty count, shortly after edits settle — so an edit that was
   * undone, or our own write echoing back as an event, does not leave
   * "pending" behind (ADR-0073). During a sync the engine queues the read
   * behind it; after a lock there is no timer left (lock clears it) and
   * `refreshFacts` reads nothing without an engine.
   */
  private refreshFactsSoon(): void {
    if (this.factsTimer !== null) clearTimeout(this.factsTimer);
    this.factsTimer = setTimeout(() => {
      this.factsTimer = null;
      void this.refreshFacts()
        .catch(() => undefined)
        .then(() => {
          this.renderStatus();
        });
    }, FACTS_SETTLE_MS);
  }

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

  /** A method, not the field: it changes across the awaits of an unlock. */
  private isUnloaded(): boolean {
    return this.unloaded;
  }

  promptUnlock(): void {
    if (this.isUnlocked() || this.unloaded) return;
    if (this.foreignProvider !== null) {
      new Notice(this.strings.notices.newerData(this.foreignProvider), 8000);
      return;
    }
    if (!settingsComplete(this.settings)) {
      new Notice(this.strings.notices.fillSettingsFirst);
      return;
    }
    // One dialog. Two used to race: the first unlocked, the second failed and
    // its error path tore the open session down without a lock (audit №4, B11).
    if (this.unlockModal !== null) return;
    const modal = new PassphraseModal(
      this.app,
      async (passphrase, create, confirmed) => {
        // Closed while checking: abandoned, nothing opens (ADR-0082).
        await this.unlock(passphrase, create, confirmed, () => modal.abandoned);
        // Only if it is still this dialog: an abandoned unlock returning late
        // cleared the NEXT dialog's slot — two dialogs, and one that unload
        // no longer closed (ADR-0083).
        if (this.unlockModal === modal) this.unlockModal = null;
      },
      () => {
        this.unlockModal = null;
      },
      this.strings,
      describeStorageLocation(this.settings),
    );
    this.unlockModal = modal;
    modal.open();
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
   * Does this passphrase NOT open the vault? (ADR-0048, ADR-0060)
   *
   * The decision lives in `passphrase-check.ts`, which has no `obsidian`
   * import and is unit-tested; this supplies the ports.
   */
  async passphraseIsWrong(passphrase: string): Promise<boolean> {
    // A prefix this build will not use cannot be checked against; the S3
    // client's refusal would read as "unreachable" (ADR-0081, ADR-0082).
    const prefix = storagePrefixOf(this.settings);
    if (prefixHasEmptySegment(prefix)) throw new UnusablePrefix(prefix);
    const adapter = this.app.vault.adapter as unknown as DataAdapterLike;
    return passphraseIsDefinitelyWrong({
      storage: await this.openStorage(),
      vault: new ObsidianVault(adapter, this.settings.profile, this.settings.configSync, this.paths),
      storagePrefix: storagePrefixOf(this.settings),
      passphrase,
      deviceId: this.settings.deviceId,
      log: this.log,
      ...(Platform.isMobile ? { affordability: { maxMemoryKiB: MOBILE_MEMORY_BUDGET_KIB } } : {}),
    });
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
      // Never creates: a ticket names a vault that exists. An empty location
      // is a ticket for the wrong place, and the person is told (ADR-0065).
      // Confirmed: the ticket opened with this passphrase, and its sharer's
      // device had it (ADR-0078).
      await this.unlock(passphrase, false, true);
    } catch (e) {
      // No modal is left open here, so the failure needs its own notice —
      // the same localized one the unlock dialog would show (audit №4, B13).
      new Notice(unlockFailureMessage(e, this.strings), 10000);
    }
  }

  /**
   * Open the vault. THROWS on failure so the caller — normally the passphrase
   * modal — can keep asking instead of the error only reaching the log.
   */
  private async unlock(
    passphrase: string,
    create = false,
    confirmed = false,
    /** The dialog this unlock answers was closed: open nothing (ADR-0082). */
    abandoned: () => boolean = () => false,
  ): Promise<void> {
    if (this.isUnlocked() || this.unloaded) return;
    if (this.foreignProvider !== null) return; // ADR-0075; promptUnlock says why
    // Settings a ticket is still writing are not settings yet (ADR-0082).
    await this.settingsSettled;
    // Where this unlock points, as of now (Q6): an edit while the keys are
    // derived is a different location, and the engine must not open the old.
    const epoch = this.storageEpoch;
    // A Lock while this unlock runs is a Lock (ADR-0085): it ends this attempt
    // too, not only the session it found. An Add-device connect has no
    // dialog to close; Lock is the person's only way to say "stop".
    const lockedAt = this.session;
    let engine: SyncEngine | null = null;
    try {
      // A sync or command from the session a lock ended is cancelled, not
      // finished: wait for it to stop before another engine opens this vault
      // (ADR-0066). Bounded (ADR-0081, post-fix Q4): the abort is seen between
      // requests, and one request that hangs used to hold the dialog on
      // "Checking…" with no way to close it. Not opened beside it either —
      // that is two engines on one vault — so the person is told to retry.
      await this.previousSessionStopped();
      this.statusEl?.setText(this.strings.status.unlocking);
      const s = this.settings;
      const adapter = this.app.vault.adapter as unknown as DataAdapterLike;
      // One base per storage location (ADR-0065): another vault's base read as
      // this vault's plans its files as edits to overwrite.
      const stateFile = this.paths.stateFileFor(storageLocationTag(s));
      const prefix = storagePrefixOf(s);
      if (prefixHasEmptySegment(prefix)) throw new UnusablePrefix(prefix);
      // Both providers go through requestUrl(): it issues a NATIVE request and
      // bypasses webview CORS, which is what made Android work at all
      // (RFC-0006 §Injectable transport). A WebDAV server is no likelier to
      // send permissive CORS headers than an S3 one.
      // Nothing is written for an unlock nobody wants any more (ADR-0083):
      // an abandoned "Create" used to write the vault's key parameters at the
      // location the person had just backed out of.
      // Only until the engine is the session's (ADR-0084): the dialog stays
      // busy through the migration preflight, and a close then set
      // `abandoned` for an engine already taken — an unlocked session whose
      // every put was refused, publishing nothing until a re-lock.
      let taken = false;
      // Reads end with the session (ADR-0085): one GET that never answers
      // (requestUrl has no timeout and cannot be aborted) kept a locked
      // session's sync "stopping" for ever, and every unlock was refused.
      // Writes are still waited for: a put that lands after a new session
      // published could overwrite what that session wrote.
      const sessionReads = new AbortController();
      const storage = abortingReadsOn(
        refusingWritesWhen(
          await this.openStorage(),
          () => !taken && (abandoned() || this.isUnloaded()),
        ),
        sessionReads.signal,
      );
      const vaultPort = new ObsidianVault(adapter, s.profile, s.configSync, this.paths);
      engine = await openSyncEngine({
        storage,
        vault: vaultPort,
        passphrase,
        deviceId: s.deviceId,
        // ADR-0036: recorded in what we publish, compared against what we read.
        clientVersion: this.manifest.version,
        storagePrefix: storagePrefixOf(s),
        state: new AdapterStateStore(adapter, stateFile),
        // An empty location becomes a vault only when the person said so in
        // the unlock dialog (ADR-0065); otherwise it is refused as VaultAbsent.
        createVault: create,
        log: this.log,
        safeSync: s.safeSync,
        // ADR-0018: creation profile is an explicit setting; mobile devices
        // refuse vaults above their Argon2id memory budget fail-closed.
        kdfDefaults:
          s.kdfProfile === "desktop-only" ? DESKTOP_KDF_PRESET : CROSS_DEVICE_KDF_PRESET,
        ...(Platform.isMobile ? { affordability: { maxMemoryKiB: MOBILE_MEMORY_BUDGET_KIB } } : {}),
      });
      // Prove the keys actually open this vault BEFORE reporting success:
      // reads and decrypts the published manifest, no local scan (RFC-0007).
      // A wrong passphrase fails here, at the modal, not halfway into the
      // first sync.
      //
      // A transient network failure is NOT a reason to refuse the vault: the
      // notes are local, editing must keep working, and the next sync will
      // verify the keys anyway. Only a definitive answer blocks the unlock.
      let unchecked = false;
      try {
        const vault = await engine.verifyAccess();
        // Nothing published: nothing to check the passphrase against. Unless
        // this unlock just created the vault (passphrase typed twice), or the
        // person has confirmed it by typing it again, ask (ADR-0078).
        if (vault === null && !create && !confirmed) throw new UncheckablePassphrase();
        if (vault === null) this.log.info(this.strings.log.freshVault);
      } catch (e) {
        if (
          !isSyncError(e, "StorageTransient") &&
          !isSyncError(e, "StorageRateLimited")
        ) {
          throw e;
        }
        this.log.warn(this.strings.log.verifyOffline);
        // Not checked; checked before anything is published (Q3). A created or
        // confirmed passphrase was typed twice already.
        unchecked = !create && !confirmed;
      }

      // A session opened and was locked while this one derived its keys: its
      // sync may still be stopping. The wait at the start could not see it
      // (ADR-0083) — two engines on one vault. (Not while a session is open:
      // that one stands, below.)
      if (!this.isUnlocked()) await this.previousSessionStopped();
      // Another path unlocked while this one was deriving keys: theirs stands.
      // Taking over would leave two engines on one vault (ADR-0066).
      if (this.isUnlocked()) return;
      // Unloaded meanwhile: this instance is gone (Q8). Or the person closed
      // the dialog while it checked: they did not ask for this any more.
      if (this.isUnloaded() || abandoned() || this.session !== lockedAt) {
        this.renderStatus(); // not "unlocking…" for an unlock nobody waits for (ADR-0085)
        return;
      }
      // The storage settings changed meanwhile: this engine is on the old
      // location under settings showing the new one (Q6, ADR-0065 §4).
      if (this.storageEpoch !== epoch) throw new LocationChanged();
      // Only now does this become the session's engine. Assigning it up front
      // meant a FAILED unlock's error path cleared someone else's (B11).
      this.engine = engine;
      this.vaultPort = vaultPort;
      this.unverified = unchecked;
      this.sessionReads = sessionReads;
      taken = true;
      this.log.info(this.strings.log.unlocked);
      this.renderStatus();

      // Migration preflight: warn about competing sync systems — never
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
      // Tear down only what THIS attempt put in place (ADR-0066).
      if (engine !== null && this.engine === engine) {
        this.engine = null;
        this.vaultPort = null;
        this.scheduler?.dispose();
        this.scheduler = null;
      }
      // A question, not a failure: the dialog asks for the passphrase again.
      if (!(e instanceof UncheckablePassphrase)) {
        this.log.warn(this.strings.log.unlockFailed(String(e)));
      }
      this.renderStatus();
      throw e; // the modal explains it; see PassphraseModal
    }
  }

  lock(): void {
    // Stop the sync in flight between operations (the engine is abort-aware),
    // and close every dialog waiting on a decision as "no": an answer given
    // after Lock must not act through the keys Lock just dropped (ADR-0016 §1,
    // ADR-0066).
    this.running?.abort.abort();
    for (const chore of this.chores) chore.abort.abort();
    this.sessionReads?.abort();
    this.sessionReads = null;
    for (const modal of [...this.openModals]) modal.close();
    this.scheduler?.dispose();
    this.scheduler = null;
    this.engine = null; // keys become unreachable; GC clears them
    this.vaultPort = null;
    this.engineStatus = null;
    for (const ref of this.vaultEvents) this.app.vault.offref(ref);
    this.vaultEvents = [];
    // A sync may still be stopping against the engine we just dropped. It
    // belongs to a session that no longer exists, so its report must not
    // become this session's status (ADR-0048); the next unlock waits for it
    // (ADR-0066).
    this.session++;
    this.syncing = false;
    this.configPulled = false;
    this.unverified = false;
    if (this.factsTimer !== null) clearTimeout(this.factsTimer);
    this.factsTimer = null;
    this.renderStatus();
    this.log.info(this.strings.log.locked);
  }

  /**
   * Wait for what an ended session left running — the sync and any command —
   * but not forever (ADR-0081, Q4). Throws PreviousSessionBusy when it has not
   * stopped in time; the dialog says so and can be closed.
   */
  private async previousSessionStopped(): Promise<void> {
    const pending = [this.running, ...this.chores]
      .filter((r) => r !== null)
      .map((r) => r.done);
    if (pending.length === 0) return;
    let timedOut = (): void => undefined;
    const late = new Promise<boolean>((resolve) => (timedOut = () => { resolve(false); }));
    const timer = setTimeout(timedOut, PREVIOUS_SESSION_WAIT_MS);
    const stopped = await Promise.race([Promise.all(pending).then(() => true), late]);
    clearTimeout(timer);
    if (!stopped) throw new PreviousSessionBusy();
  }

  /**
   * Before anything that can publish (Q3): a passphrase taken while the
   * storage was unreachable is checked now. Nothing published yet → ADR-0078's
   * question was never asked, so the device locks and asks it; a passphrase
   * the vault refuses locks too. True when the caller may go on.
   */
  private async passphraseChecked(engine: SyncEngine, signal?: AbortSignal): Promise<boolean> {
    if (!this.unverified) return true;
    const session = this.session;
    let published: { generation: number } | null;
    try {
      published = await engine.verifyAccess(signal);
    } catch (e) {
      if (session === this.session && isSyncError(e, "CryptoAuthError")) {
        this.lock();
        new Notice(this.strings.notices.unlockRecheckWrong, 12000);
        this.promptUnlock();
        return false;
      }
      throw e; // still offline: the caller fails as any sync would
    }
    if (session !== this.session) return false;
    if (published === null) {
      this.lock();
      new Notice(this.strings.notices.unlockRecheckUncheckable, 12000);
      this.promptUnlock();
      return false;
    }
    this.unverified = false;
    return true;
  }

  // -- triggers ---------------------------------------------------------------

  private registerVaultEvents(): void {
    if (this.vaultEvents.length > 0) return; // already listening (ADR-0048)
    const note = (path: string): void => {
      // Our own trash moves and dot-file writes must not retrigger sync.
      if (path.startsWith(this.paths.syncTrash) || path.startsWith(".")) return;
      this.scheduler?.noteChange();
      // An edit is unsynced until a status says otherwise (ADR-0073). The
      // comment here used to promise "pending" while the render read the
      // dirty count of the LAST status — zero — and said "Synced" over an
      // edit, for good with auto-sync off.
      if (this.engineStatus !== null && this.engineStatus.dirtyFiles === 0) {
        this.engineStatus = { ...this.engineStatus, dirtyFiles: 1 };
      }
      this.renderStatus();
      this.refreshFactsSoon();
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
    if (!this.isUnlocked() || !this.settings.autoSync.enabled) {
      this.scheduler?.dispose();
      this.scheduler = null;
      return;
    }
    const opts = {
      debounceMs: this.settings.autoSync.debounceSec * 1000,
      minIntervalMs: this.settings.autoSync.minIntervalSec * 1000,
      retryMs: RETRY_DECLINED_MS,
      periodicMs: this.settings.autoSync.periodicSec * 1000,
    };
    // Retimed in place, keeping a pending edit and the last sync's time
    // (ADR-0072). Rebuilding dropped both on every keystroke in the field.
    if (this.scheduler !== null) {
      this.scheduler.setOptions(opts);
      return;
    }
    this.scheduler = new AutoSyncScheduler(() => void this.syncNow("auto"), opts);
    this.scheduler.armPeriodic();
  }

  /**
   * Hand the include/exclude profile and the Safe Sync options to the open
   * vault port and engine (ADR-0072). Both were read once at unlock, so an
   * edit took effect after the next lock — with "Count files" already showing
   * the new profile and a hand-tightened breaker not firing. Between syncs: a
   * running one finishes on the settings it started with.
   */
  async applyLiveSettings(): Promise<void> {
    if (this.syncing) {
      this.liveSettingsPending = true;
      return;
    }
    this.liveSettingsPending = false;
    this.vaultPort?.setProfile(this.settings.profile);
    await this.engine?.setSafeSync(this.settings.safeSync);
  }

  // -- sync -----------------------------------------------------------------

  /**
   * One sync — or, for "background" (quit, app to background), a push only,
   * best effort, with no dialog and no notice (RFC-0004). Every one is held in
   * `running` (ADR-0066, ADR-0081).
   */
  async syncNow(origin: "manual" | "auto" | "startup" | "background"): Promise<void> {
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
    const engine = this.engine;
    // Read at the start: what this pull could bring is decided by what was
    // syncable when it scanned, not by a toggle flipped while it ran.
    const configOn = this.settings.configSync.enabled;
    if (!configOn) this.configPulled = false;
    const abort = new AbortController();
    let stopped = (): void => undefined;
    const run = { abort, done: new Promise<void>((r) => (stopped = r)) };
    this.running = run;
    this.syncing = true;
    this.syncStartLogLength = this.log.entryCount();
    this.scheduler?.noteSyncStarted();
    this.renderStatus();
    try {
      if (!(await this.passphraseChecked(engine, abort.signal))) return;
      if (origin === "background") {
        // Nobody to ask: a push Safe Sync holds back waits for the next sync.
        // Not a sync: nothing was pulled, so it reports nothing — a push
        // report has no conflicts and would wipe the ones the last sync
        // named (ADR-0082). The facts refreshed below show what is pending.
        await engine.push(abort.signal);
        return;
      }
      let report = await engine.sync(abort.signal);
      if (report.outcome === "needs-confirmation") {
        report = await this.handleConfirmation(engine, session, report, abort.signal);
      }
      if (session === this.session) {
        this.lastError = null;
        if (configOn && pullCompleted(report.outcome)) this.configPulled = true;
        this.finishReport(report, origin);
      }
    } catch (e) {
      this.lastError =
        session === this.session
          ? isSyncError(e, "StorageTransient") || isSyncError(e, "StorageRateLimited")
            ? "network"
            : "other"
          : this.lastError;
      if (session === this.session) this.lastSyncAt = Date.now();
      // A sync that a lock cancelled did not fail; the lock is already in the
      // log. Anything else an ended session hits is still written down.
      if (session === this.session || !isSyncError(e, "Aborted")) {
        this.log.warn(this.strings.log.syncFailed(String(e)));
      }
      if (origin !== "auto" && origin !== "background" && session === this.session) {
        new Notice(this.strings.notices.syncFailed(syncFailureMessage(e, this.strings)), 8000);
      }
    } finally {
      // Still inside the `syncing` guard: adopting a shared profile changes
      // what this device syncs, so it must not race the next sync (ADR-0024).
      if (session === this.session) {
        await this.reconcileSharedConfig().catch(() => undefined);
        this.syncing = false;
        if (this.liveSettingsPending) await this.applyLiveSettings().catch(() => undefined);
        await this.refreshFacts().catch(() => undefined);
      }
      this.renderStatus();
      if (this.running === run) this.running = null;
      stopped();
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
      } else if (!this.configPulled) {
        // No file here, and no completed pull to say the vault has none. It
        // may well have one this device has not fetched yet; writing ours now
        // would become a conflict that keeps ours at the path and pushes it
        // over the vault's (ADR-0068). The next completed sync decides.
        this.log.info(this.strings.log.configSyncDeferred);
        return;
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

  /**
   * The Safe Sync question, on the engine and session that raised it. It used
   * to re-read `this.engine` after the dialog: null after a Lock (a raw
   * TypeError on screen), or a NEW session's engine, which then applied a plan
   * made on the old one (audit №4, B3; ADR-0066).
   */
  private async handleConfirmation(
    engine: SyncEngine,
    session: number,
    original: SyncReport,
    signal: AbortSignal,
    attempt = 1,
  ): Promise<SyncReport> {
    const plan = await engine.dryRun(signal);
    if (session !== this.session) return original;
    const approved = await this.ask<boolean>((resolve) =>
      new ConfirmSyncModal(this.app, plan, resolve, this.strings),
    );
    if (!approved || session !== this.session) {
      this.log.info(this.strings.log.bulkCancelled);
      return original;
    }
    const result = await engine.confirmAndApply(plan, signal);
    // The engine refuses a plan that changed under the dialog (another delete
    // while the list was open) and applies nothing — correctly. It used to
    // stop there in silence: one log line, a "pending" status, no question
    // (audit №4, B10). Say so and ask about the list as it is now — twice at
    // most, so a vault that never settles is not an endless dialog.
    if (result.outcome !== "needs-confirmation" || session !== this.session) return result;
    if (attempt >= MAX_CONFIRMATION_ROUNDS) {
      new Notice(this.strings.notices.confirmationGaveUp, 10000);
      return result;
    }
    new Notice(this.strings.notices.confirmationChanged, 8000);
    return this.handleConfirmation(engine, session, result, signal, attempt + 1);
  }

  /**
   * Open a dialog and wait for its decision. A lock closes it, which every
   * dialog here answers as "no" (ADR-0066).
   */
  private ask<T>(
    open: (resolve: (value: T) => void) => { open(): void; close(): void },
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const modal = open((value) => {
        this.openModals.delete(modal);
        resolve(value);
      });
      this.openModals.add(modal);
      modal.open();
    });
  }

  /**
   * Run a maintenance command against the engine of THIS session. `current()`
   * says whether that is still so; each command checks it after every wait —
   * a lock can land while a preview is computed or a dialog is open, and the
   * answer must not act through the keys the lock dropped (ADR-0066). Failures
   * reach the screen; these commands used to drop them (audit №4, B9).
   */
  private async maintenance(
    run: (engine: SyncEngine, current: () => boolean, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const engine = this.engine;
    if (engine === null) {
      this.promptUnlock();
      return;
    }
    const session = this.session;
    const current = (): boolean => session === this.session && engine === this.engine;
    // Held like the sync (ADR-0081, Q7): Lock aborts it, the next unlock waits.
    const abort = new AbortController();
    let stopped = (): void => undefined;
    const chore = { abort, done: new Promise<void>((r) => (stopped = r)) };
    this.chores.add(chore);
    try {
      if (!(await this.passphraseChecked(engine, abort.signal))) return;
      await run(engine, current, abort.signal);
    } catch (e) {
      if (!current()) return; // the lock already said why
      this.log.warn(this.strings.log.commandFailed(String(e)));
      new Notice(this.strings.notices.commandFailed(commandFailureMessage(e, this.strings)), 10000);
    } finally {
      this.chores.delete(chore);
      stopped();
    }
  }

  /** Said when a lock overtook a command: nothing was done. */
  private lockedMeanwhile(): void {
    new Notice(this.strings.notices.lockedMeanwhile, 8000);
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
    await this.maintenance(async (engine, current, signal) => {
      const candidates = await engine.listUncarried(signal);
      if (!current()) return;
      if (candidates.length === 0) {
        new Notice(this.strings.forgetModal.noneFound, 6000);
        return;
      }
      const chosen = await this.ask<string[]>((resolve) =>
        new ForgetPathsModal(this.app, candidates, resolve, this.strings),
      );
      if (chosen.length === 0) return;
      if (!current()) {
        this.lockedMeanwhile();
        return;
      }
      const result = await engine.forgetPaths(chosen, signal);
      if (!current()) return; // the lock already said so (Q7)
      if (result.generation === null) {
        new Notice(this.strings.forgetModal.raced, 8000);
        return;
      }
      new Notice(this.strings.forgetModal.done(result.forgotten.length), 8000);
      await this.refreshFacts().catch(() => undefined);
      this.renderStatus();
    });
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
    await this.maintenance(async (engine, current, signal) => {
      const { baseGeneration } = await engine.status();
      // No manifest at all is generation 0 — a wiped bucket is a rollback too.
      const remoteGeneration = (await engine.verifyAccess(signal))?.generation ?? 0;
      if (!current()) return;
      if (baseGeneration === null || remoteGeneration >= baseGeneration) {
        new Notice(this.strings.notices.notRolledBack, 6000);
        return;
      }
      const approved = await this.ask<boolean>((resolve) =>
        new AcceptStorageModal(this.app, remoteGeneration, baseGeneration, resolve, this.strings),
      );
      if (!approved) return;
      if (!current()) {
        this.lockedMeanwhile();
        return;
      }
      // Checked again at the moment of acceptance, in the same queued step as
      // the forget: the storage may have caught up while the dialog was open,
      // and forgetting the base against a storage that is no longer behind
      // brings deleted files back (ADR-0071).
      const accepted = await engine.acceptRolledBack(signal);
      // Locked during the accept: no "accepted", and no follow-up sync — on
      // a locked device that is a passphrase dialog nobody asked for (Q7).
      if (!current()) return;
      if (!accepted) {
        new Notice(this.strings.notices.notRolledBack, 6000);
        return;
      }
      new Notice(this.strings.notices.storageAccepted, 8000);
      await this.syncNow("manual");
    });
  }

  /**
   * Release the copies kept for forgotten entries (ADR-0055).
   *
   * Its own command, deliberately: forgetting is reversible precisely because
   * this step is separate, and folding it into the reclaim dialog would make
   * one confirmation stand for two very different decisions.
   */
  async releaseForgotten(): Promise<void> {
    await this.maintenance(async (engine, current, signal) => {
      // From the storage, not from this device's base: another device may have
      // forgotten more since this one last synced, and every copy released
      // has to have been named here first (ADR-0070).
      const keys = await engine.previewRelease(signal);
      const kept = keys.length;
      if (!current()) return;
      const approved = await this.ask<boolean>((resolve) =>
        new ReleaseForgottenModal(this.app, kept, resolve, this.strings),
      );
      if (!approved || kept === 0) return;
      if (!current()) {
        this.lockedMeanwhile();
        return;
      }
      const result = await engine.releaseForgotten(signal, keys);
      if (!current()) return; // the lock already said so (Q7)
      if (result.stale === true) {
        new Notice(this.strings.releaseModal.changed, 8000);
        return;
      }
      if (result.generation === null) {
        new Notice(this.strings.releaseModal.raced, 8000);
        return;
      }
      new Notice(this.strings.releaseModal.done(result.released), 8000);
      await this.refreshFacts().catch(() => undefined);
      this.renderStatus();
    });
  }

  /**
   * Reclaim storage (ADR-0030): preview, confirm, sweep. The one operation
   * nothing undoes, so it is a command the user runs deliberately, never a
   * side effect of syncing — and the plan shown is recomputed inside the
   * engine before anything is deleted, never executed as previewed.
   */
  async reclaimStorage(): Promise<void> {
    await this.maintenance(async (engine, current, signal) => {
      await this.reclaimWith(engine, current, signal);
    });
  }

  private async reclaimWith(
    engine: SyncEngine,
    current: () => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const plan = await engine.previewReclaim(signal);
    if (!current()) return;
    const approved = await this.ask<boolean>((resolve) =>
      new ReclaimStorageModal(this.app, plan, resolve, this.strings),
    );
    if (!current()) {
      if (approved) this.lockedMeanwhile();
      return;
    }
    // Nothing ripe and nothing to prune is the NORMAL first outcome: there was
    // no decision to make, so closing the dialog is not a "no". Persist the
    // mark, or the grace window would never start for a user who only looks.
    // When there WAS something to approve, cancel means cancel.
    //
    // Either way the engine is told what was SHOWN, as a ceiling: it
    // recomputes (ADR-0030 — never sweep a stale plan), and the recomputation
    // may find more ripe by now, or a generation published while the dialog
    // was open. Closing used to run the full operation and delete exactly
    // that, under a notice saying "nothing is deletable yet"; Reclaim used to
    // delete more than the dialog listed (ADR-0067).
    const actionable = plan.sweep.length > 0 || plan.prunedManifests.length > 0;
    if (!approved) {
      if (!actionable && plan.waiting > 0 && plan.ripeAt !== null) {
        await engine.reclaimStorage(signal, { sweep: [], prunedManifests: [] });
        if (!current()) return;
        new Notice(
          this.strings.reclaimModal.noneYet(new Date(plan.ripeAt * 1000).toLocaleString()),
          8000,
        );
      }
      return;
    }
    const result = await engine.reclaimStorage(signal, {
      sweep: plan.sweep,
      prunedManifests: plan.prunedManifests,
    });
    // Locked mid-sweep: what was deleted before the abort is in the log; a
    // "done" notice would be said for a session that no longer exists (Q7).
    if (!current()) return;
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
    // Read-only under a newer build's data.json (ADR-0075).
    if (this.foreignProvider !== null) {
      new Notice(this.strings.notices.newerData(this.foreignProvider), 8000);
      return;
    }
    // Never contains the passphrase (ADR-0016). Fields a newer build wrote ride
    // along untouched.
    await this.saveData({ ...this.extraData, ...this.settings });
  }

  /**
   * A storage setting was edited. An open engine is bound to the storage it
   * was opened on, and kept writing there while Settings showed the new one
   * (audit №4, W2). Changing WHERE — or with which keys — is a reconnect, the
   * same as switching provider: lock now, and the next unlock opens the new
   * location with its own base (ADR-0065).
   */
  storageSettingsChanged(): void {
    // Also seen by an unlock still deriving keys (Q6): it is refused rather
    // than opened on the location it read before this edit.
    this.storageEpoch++;
    if (!this.isUnlocked()) return;
    this.lock();
    new Notice(this.strings.notices.storageChangedLocked, 10000);
  }

  /**
   * Replace the settings with `next`, IN PLACE, and persist them.
   *
   * In place because the open settings tab holds this object: swapping in a
   * new one left the tab editing a copy nobody saved (audit №4, A5). Rolled
   * back if the write fails. A device that was unlocked is locked: new
   * settings from a ticket are a different connection, and the engine must
   * not keep running on the old one (W3).
   */
  async replaceSettings(next: SyncryptSettings): Promise<void> {
    // Read-only under a newer build's data.json (ADR-0075): saveSettings()
    // writes nothing there and says so in a notice, which let a ticket be
    // announced as imported while nothing was saved (ADR-0081, Q9).
    if (this.foreignProvider !== null) throw new SettingsReadOnly(this.foreignProvider);
    const previous = structuredClone(this.settings);
    Object.assign(this.settings, structuredClone(next));
    // A different connection, for an unlock in flight too (Q6) — from the
    // moment the settings in memory change, not after the save: an unlock
    // reading them during a save that then failed used to pass (ADR-0082).
    this.storageEpoch++;
    if (this.isUnlocked()) this.lock();
    // An unlock waits for this save (ADR-0082): one that opened the ticket's
    // location during a save that then failed synced it in — and, the
    // settings rolled back, the next unlock uploaded those files into the old
    // vault.
    const saving = this.saveSettings();
    this.settingsSettled = saving.catch(() => undefined);
    try {
      await saving;
    } catch (e) {
      // No unlock can have opened the ticket's location meanwhile: an unlock
      // already running saw the epoch move, a new one waited for this save.
      Object.assign(this.settings, previous);
      throw e;
    }
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- re-render; see settings-tab.ts
    this.settingTab?.display();
  }
}

/**
 * A sync whose pull ran to the end: what is on disk now includes everything
 * the vault had that this device syncs. `pull-first`, `rolled-back`,
 * `needs-confirmation` (a declined bulk change) and `aborted` stopped short.
 */
function pullCompleted(outcome: SyncOutcome): boolean {
  return outcome === "applied" || outcome === "no-op" || outcome === "conflicts";
}

/**
 * This installation's vault-scoped localStorage (Obsidian 1.8.7+), or null on
 * an older client — which keeps the old behaviour: the ID lives in data.json.
 */
function installStore(app: App): InstallStore | null {
  const host = app as Partial<Pick<App, "loadLocalStorage" | "saveLocalStorage">>;
  const load = host.loadLocalStorage;
  const save = host.saveLocalStorage;
  if (typeof load !== "function" || typeof save !== "function") return null;
  return {
    load: () => {
      const v: unknown = load.call(app, DEVICE_ID_KEY);
      return typeof v === "string" ? v : null;
    },
    save: (id) => {
      save.call(app, DEVICE_ID_KEY, id);
    },
  };
}

/**
 * The storage, refusing puts once `refused()` says so (ADR-0083): an unlock's
 * engine creates nothing after its dialog was closed or the plugin unloaded.
 * Reads go on, and fail nothing.
 */
function refusingWritesWhen(storage: StoragePort, refused: () => boolean): StoragePort {
  const stop = (what: string): Promise<never> =>
    Promise.reject(new SyncError("Aborted", `${what} refused: the unlock was abandoned`));
  return {
    put: (key, data, opts) => (refused() ? stop("put") : storage.put(key, data, opts)),
    // An unlock deletes nothing; its put is the vault's creation.
    delete: (key) => storage.delete(key),
    get: (key) => storage.get(key),
    stat: (key) => storage.stat(key),
    list: (prefix) => storage.list(prefix),
    capabilities: () => storage.capabilities(),
  };
}

/**
 * The storage, whose pending and future READS reject once `signal` aborts
 * (ADR-0085). Puts and deletes are untouched: they are waited for.
 */
function abortingReadsOn(storage: StoragePort, signal: AbortSignal): StoragePort {
  const aborted = (): SyncError => new SyncError("Aborted", "the session was locked");
  const race = <T>(p: Promise<T>): Promise<T> => {
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise<T>((resolve, reject) => {
      const stop = (): void => { reject(aborted()); };
      signal.addEventListener("abort", stop, { once: true });
      p.then(
        (v) => { signal.removeEventListener("abort", stop); resolve(v); },
        (e: unknown) => { signal.removeEventListener("abort", stop); reject(e instanceof Error ? e : new Error(String(e))); },
      );
    });
  };
  // The re-LIST that confirms a manifest put is part of the write (review
  // №6, R1): aborted, the generation that landed was never adopted, and the
  // next sync planned this device's own edits against the old base.
  let confirming = false;
  const isManifest = (k: string): boolean => k.includes("manifests/");
  return {
    put: async (key, data, opts) => {
      const result = await storage.put(key, data, opts);
      if (isManifest(key)) confirming = true;
      return result;
    },
    delete: (key) => storage.delete(key),
    get: (key) => race(storage.get(key)),
    stat: (key) => race(storage.stat(key)),
    list: (prefix) => {
      const waited = confirming && isManifest(prefix);
      if (waited) confirming = false;
      return {
        [Symbol.asyncIterator]: () => {
          const inner = storage.list(prefix)[Symbol.asyncIterator]();
          return { next: () => (waited ? inner.next() : race(inner.next())) };
        },
      };
    },
    capabilities: () => storage.capabilities(),
  };
}
