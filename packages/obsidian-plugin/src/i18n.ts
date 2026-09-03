// UI localization (ADR-0021). The engine stays language-agnostic: it emits
// stable `ReasonCode`s and typed errors, and the CLIENT decides how to phrase
// them. Nothing here reaches storage, the manifest, or the log's semantics —
// only what a human reads on screen.
//
// English is the source of truth: `Strings` is derived from `EN`, so a missing
// or renamed key fails `tsc` instead of silently falling back at runtime.

import { ReasonCode, type SyncOutcome } from "@syncrypt/core";

/**
 * A span a reader can judge at a glance ("7 h 12 min", "40 min"). Deliberately
 * coarse: the point of ADR-0029's line is "this took hours", not a stopwatch.
 */
function spanParts(seconds: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.round(seconds / 60));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

function spanEn(seconds: number): string {
  const { hours, minutes } = spanParts(seconds);
  if (hours === 0) return `${String(minutes)} min`;
  return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`;
}

function spanRu(seconds: number): string {
  const { hours, minutes } = spanParts(seconds);
  if (hours === 0) return `${String(minutes)} мин`;
  return minutes === 0 ? `${String(hours)} ч` : `${String(hours)} ч ${String(minutes)} мин`;
}

export type Lang = "en" | "ru";
/** Settings value: follow Obsidian ("auto") or pin a language. */
export type LangSetting = "auto" | Lang;

/**
 * Where Obsidian's interface language can be read from. Both are collected by
 * the plugin (which may touch `window` and the `obsidian` module) and passed
 * in, so the resolution itself stays pure and testable.
 */
export interface LanguageSources {
  /** localStorage["language"] — ABSENT (null) when the UI is English. */
  storage?: string | null;
  /** moment.locale(); Obsidian sets it from the interface language. */
  moment?: string | null;
}

/** First source that names a language we speak wins; otherwise English. */
export function detectLang(sources: LanguageSources): Lang {
  for (const raw of [sources.storage, sources.moment]) {
    if (raw === null || raw === undefined || raw === "") continue;
    if (raw.toLowerCase().startsWith("ru")) return "ru";
  }
  return "en";
}

export function resolveLang(setting: LangSetting, sources: LanguageSources): Lang {
  return setting === "auto" ? detectLang(sources) : setting;
}

/** Human-readable "what did we see, what did we pick" for the settings UI. */
export function describeDetection(sources: LanguageSources): string {
  const seen = [
    `localStorage: ${sources.storage ?? "—"}`,
    `moment: ${sources.moment ?? "—"}`,
  ].join(", ");
  return `${seen} → ${detectLang(sources)}`;
}

const EN = {
  status: {
    lockedLabel: "Syncrypt: locked",
    lockedTooltip: "Unlock with your passphrase to sync.",
    syncingLabel: (progress: string) => `Syncrypt: syncing${progress}`,
    syncingTooltip: "Sync in progress.",
    offlineLabel: "Syncrypt: offline",
    offlineTooltip:
      "Storage is unreachable; your edits are safe locally and will sync when the connection returns.",
    errorLabel: "Syncrypt: error",
    errorTooltip: "The last sync failed — see the sync log.",
    rolledBackLabel: "Syncrypt: storage rolled back",
    rolledBackTooltip:
      "Sync is refusing: the storage holds an older state than this device already had. Nothing was changed — see the sync log.",
    conflictLabel: (n: number) => `Syncrypt: conflict (${String(n)})`,
    conflictTooltip: (n: number) =>
      `${String(n)} conflict(s) — both versions were kept; merge them and sync again.`,
    conflictPaths: (shown: string[], more: number) =>
      `\n${shown.join(" · ")}${more > 0 ? ` … and ${String(more)} more` : ""}`,
    syncedLabel: "Syncrypt: synced ✓",
    syncedTooltip: "Everything is synced.",
    pendingLabel: "Syncrypt: pending",
    pendingNoSyncYet: "No sync has completed yet this session.",
    pendingDirty: (n: number) => `${String(n)} local change(s) not yet uploaded.`,
    pendingNeedsConfirmation: "A bulk change is waiting for your confirmation.",
    pendingUnclean: "The last sync did not complete cleanly.",
    factsLastSync: (time: string) => `last sync ${time}`,
    factsCounts: (notes: number, attachments: number) =>
      `${String(notes)} notes, ${String(attachments)} attachments`,
    factsGeneration: (generation: number) => `generation #${String(generation)}`,
    unlocking: "Syncrypt: unlocking…",
    waitingForWifi: "Syncrypt: waiting for Wi-Fi",
    statusPrefix: "Status: ",
  },

  reasons: {
    [ReasonCode.NewLocalFile]: "new local file → uploaded",
    [ReasonCode.LocalChanged]: "local hash differs from base → uploaded",
    [ReasonCode.RemoteNewer]: "remote version is newer → downloaded",
    [ReasonCode.NewRemoteFile]: "new remote file → downloaded",
    [ReasonCode.DeletedRemotely]: "marked as deleted in manifest → removed locally",
    [ReasonCode.DeletedLocally]: "deleted locally → tombstoned remotely",
    [ReasonCode.ConflictBothChanged]: "changed on both sides → conflict (not merged)",
    [ReasonCode.ConflictSamePath]: "same path created independently → conflict",
    [ReasonCode.ConflictEditDelete]: "edited on one side, deleted on the other → conflict",
    [ReasonCode.ConvergedNoop]: "already in sync → nothing to do",
  } as Record<ReasonCode, string>,

  log: {
    viewTitle: "Syncrypt log",
    heading: "Sync log",
    empty: "Nothing synced yet.",
    unlocked: "Syncrypt unlocked.",
    freshVault: "This vault has no manifest in storage yet — the first sync will create one.",
    verifyOffline:
      "Unlocked without reaching storage — the passphrase could not be verified yet; editing works and the next sync will check it.",
    locked: "Syncrypt locked — keys forgotten.",
    configureFirst: "Syncrypt: configure storage in Settings, then unlock.",
    unlockFailed: (detail: string) => `Unlock failed: ${detail}`,
    syncFailed: (detail: string) => `Sync failed: ${detail}`,
    bulkCancelled: "Bulk change NOT applied — cancelled by you.",
    configSyncAdopted: (summary: string) =>
      `Obsidian-settings sync: adopted the shared profile from this vault (${summary}).`,
    ticketAge: (when: string, days: number) =>
      `Connection ticket accepted. Created ${when} (${String(days)} days ago) — delete the copy you transferred.`,
    configSyncPublished:
      "Obsidian-settings sync: published this device's profile for the other devices.",
    configSyncUnreadable:
      "Obsidian-settings sync: the shared profile file could not be read — keeping this device's own settings.",
    configSyncConflicted: (sharedPath: string, copyPath: string | undefined) =>
      copyPath === undefined
        ? `Obsidian-settings sync: "${sharedPath}" was changed on two devices — this device kept its own settings and nothing was overwritten. Set the options you want here and this device will publish them for the others.`
        : `Obsidian-settings sync: "${sharedPath}" was changed on two devices. This device kept its own settings; the other device's version is beside it as "${copyPath}". Both files live in a folder Obsidian does not show in the file list — compare them in a file manager, or simply set the options you want here and this device will publish them for the others.`,
    conflictsFound: (shown: string[], more: number) =>
      `Conflicts — both versions were kept, nothing was overwritten. Merge these by hand, then sync again: ${shown.join(", ")}${more > 0 ? ` … and ${String(more)} more` : ""}`,
    hashCacheCleared: "Cached file hashes forgotten — the next scan re-reads the whole vault once.",
  },

  /**
   * Everything the engine reports, phrased here (ADR-0026). The engine hands
   * over a code and its facts; the wording is ours, in the reader's language.
   */
  reclaimModal: {
    title: "Reclaim storage",
    nothing:
      "Nothing to reclaim: every stored object is still referenced, and there are no old manifest generations to prune.",
    ready: (objects: number, size: string) =>
      `${String(objects)} object${objects === 1 ? "" : "s"} (${size}) are referenced by nothing and have waited out the safety window.`,
    alsoManifests: (manifests: number) =>
      `${String(manifests)} old manifest generation${manifests === 1 ? "" : "s"} would be pruned as well. Point-in-time recovery stays available for the newest generations and for each file's retained versions.`,
    waiting: (objects: number, size: string, when: string) =>
      `${String(objects)} object${objects === 1 ? "" : "s"} (${size}) are referenced by nothing, but have not waited out the safety window yet. Run this again after ${when} and they can go.`,
    marked:
      "They are noted, with the time they were first seen unreferenced — running this command again in the meantime does not restart their clock.",
    danger:
      "This is the one thing Syncrypt does that nothing undoes. A deleted object is gone: no trash, no retained version, no other device that puts it back. It is safe because nothing any kept manifest still points at is ever a candidate — and that is checked again at the moment of deletion, never taken from this preview.",
    cancel: "Cancel",
    confirm: "Reclaim",
    close: "Close",
    done: (deleted: number, freed: string) =>
      `Syncrypt: ${String(deleted)} object${deleted === 1 ? "" : "s"} deleted, ${freed} freed.`,
    noneYet: (when: string) =>
      `Syncrypt: nothing is deletable yet — the objects are noted and can go after ${when}.`,
  },

  acceptStorageModal: {
    title: "Accept the storage as it is",
    what: (remote: number, base: number) =>
      `The storage is at generation ${String(remote)}. This device last synced against generation ${String(base)}, so something removed manifests from the storage. Until you decide which happened, syncing refuses.`,
    restored:
      "If you restored the bucket from a backup, or cleaned it out yourself, this is expected: accept it and syncing continues from the restored state.",
    notRestored:
      "If you did not, do NOT accept it. Someone with write access to the bucket can roll every device back this way. Check who has that access first — nothing has been changed here.",
    effect:
      "Accepting forgets only what this device remembers about the last sync. No file is deleted and nothing is uploaded yet: the next sync compares both sides from scratch, keeps both versions of anything that differs as a conflict copy, and deletes nothing.",
    cancel: "Cancel",
    confirm: "Accept the storage",
  },

  forgetModal: {
    title: "Files in the manifest that this device does not carry",
    intro: (n: number) =>
      `${String(n)} entr${n === 1 ? "y" : "ies"} are listed in the vault's manifest but fall outside this device's sync profile. Some are alive on another device; some may be left over from a profile nobody uses any more. Only you can tell which.`,
    safety:
      "Forgetting is not deleting: no file is touched and no deletion is recorded. Any device that still carries a path will simply put it back on its next sync.",
    empty: "Nothing to review — this device carries everything in the manifest.",
    cancel: "Cancel",
    forget: (n: number) => (n === 0 ? "Forget selected" : `Forget ${String(n)} selected`),
    noneFound: "Syncrypt: this device carries everything in the manifest — nothing to clean up.",
    done: (n: number) =>
      `Syncrypt: ${String(n)} entr${n === 1 ? "y" : "ies"} forgotten. Anything another device still carries will come back on its next sync.`,
    raced: "Syncrypt: another device published first — nothing was changed. Sync and try again.",
  },

  engine: {
    syncOutcome: {
      applied: "Sync finished: changes applied.",
      "pull-first": "Sync stopped — pull first.",
      "needs-confirmation": "Sync stopped — waiting for your confirmation.",
      conflicts: "Sync finished with conflicts — both versions kept.",
      "no-op": "Sync finished: nothing to do.",
      aborted: "Sync interrupted — nothing was left half-applied.",
      "rolled-back": "Sync refused — the storage holds an older state than this device.",
    } as Record<SyncOutcome, string>,
    pullFirst: "Sync stopped. Pull first — someone else published a newer version.",
    confirmationRequired: (destructive: number, total: number) =>
      `Waiting for confirmation: this sync would delete or overwrite ${String(destructive)} of ${String(total)} local files.`,
    confirmationRequiredPlain: "Waiting for your confirmation before anything is applied.",
    confirmationStale: (n: number) =>
      `The plan changed since you confirmed it (${String(n)} new destructive operations) — confirm again.`,
    stateUnreadable: (detail: string) =>
      `Local sync state unreadable — reconciling from scratch, which is slower but safe (${detail}).`,
    dedupProbeUnavailable: (path: string, detail: string) =>
      `Could not check whether "${path}" is already in storage — uploading it anyway (${detail}).`,
    manifestEntriesForgotten: (count: number, generation: number) =>
      `Forgot ${String(count)} manifest entr${count === 1 ? "y" : "ies"} (generation ${String(generation)}). No file was deleted; a device that still carries one will re-add it.`,
    vaultWrittenByNewer: (writer: string, self: string) =>
      `This vault was last published by Syncrypt ${writer}, and this device is running ${self}. Update this device before making big changes here: a newer version can write things an older one reads differently.`,
    vaultWrittenByOlder: (writer: string | undefined, self: string) =>
      `Another device is running ${writer === undefined || writer === "" ? "an older Syncrypt" : `Syncrypt ${writer}`}; this one is running ${self}. Syncing works, but until every device is updated they do not all behave the same way — update the others when you can.`,
    forkLost: (generation: number) =>
      `Two devices published generation ${String(generation)} at the same moment, and this one did not win (ADR-0006 §4). Its own view of that generation is not what the others will read, so this sync compares against the published version instead of it. Files that differ come back as conflicts with both versions kept — nothing is overwritten, and nothing you deleted around then stays deleted.`,
    tombstonesExpired: (count: number, days: number) =>
      `${String(count)} deletion record${count === 1 ? "" : "s"} older than ${String(days)} days dropped from the manifest (ADR-0031). The files stay deleted; only the record of the deletion is gone. A device that has been offline longer than that will bring its copies back — delete them again if it does.`,
    storageReclaimed: (deleted: number, freed: string, manifests: number, waiting: number) =>
      `Storage reclaimed: ${String(deleted)} object${deleted === 1 ? "" : "s"} deleted (${freed}), ${String(manifests)} old manifest generation${manifests === 1 ? "" : "s"} pruned, ${String(waiting)} object${waiting === 1 ? "" : "s"} still waiting out the safety window.`,
    storageRolledBack: (remote: number, base: number) =>
      `Sync refused: the storage is at generation ${String(remote)}, and this device already synced against generation ${String(base)} (ADR-0038). Generations only ever go up, so manifests were removed — by a restore from an older backup, by a cleanup, or by someone with write access to the bucket. Applying it would quietly put an older copy of every file back. Nothing was changed. If you restored the storage on purpose, run "Accept the storage as it is" and sync again; if you did not, check who can write to that bucket before syncing anything.`,
    deletionsPaced: (paced: number, spanSeconds: number, destructive: number) =>
      `${String(paced)} deletions came in from another device, spread over ${spanEn(spanSeconds)} — the pace of someone working, not of something going wrong, so the confirmation for ${String(destructive)} destructive changes was not asked for (ADR-0029). The deleted files are in the sync trash.`,
  },

  entryDetail: {
    conflictCopySaved: (copyPath: string) => `remote version saved as "${copyPath}"`,
    remoteEditRestored: "restored the remotely-edited version; delete again to confirm",
    localEditKept: "kept the locally-edited file; it will be re-uploaded",
  },

  notices: {
    fillSettingsFirst: "Syncrypt: fill in the storage settings first.",
    configureBeforeSharing: "Syncrypt: configure and verify storage first.",
    unlockFailed: (detail: string) => `Syncrypt: unlock failed — ${detail}`,
    syncFailed: (detail: string) => `Syncrypt: sync failed — ${detail}`,
    migrationWarnings: (n: number) =>
      `Syncrypt: ${String(n)} migration warning(s) — see the sync log before continuing.`,
    conflicts: (n: number) =>
      `Syncrypt: ${String(n)} conflict(s) — both versions kept, see the sync log.`,
    conflictOne: (path: string) =>
      `Syncrypt: conflict in "${path}" — both versions kept, see the sync log.`,
    alreadyInSync: "Syncrypt: already in sync.",
    ticketCopied: "Ticket copied.",
    sharePassphraseWrong:
      "Syncrypt: that passphrase does not open this vault — the ticket would be unusable on the other device.",
    ticketRejected: (detail: string) => `Syncrypt: ticket rejected — ${detail}`,
    ticketImportedNoCreds:
      "Connection settings imported WITHOUT credentials — enter the storage keys in Settings, then Unlock.",
    ticketImported: "Connection imported. Connecting… (delete the transferred ticket now)",
    deviceIdCopied: "Device ID copied",
    configSyncAdopted: "Syncrypt: Obsidian-settings profile updated from another device.",
    configSyncSecretPlugins: (names: string) =>
      `Syncrypt: another device turned on settings sync for ${names} — plugins that can keep API keys in data.json. Turn it off here if you would rather not.`,
    ticketOld: (days: number) =>
      `Syncrypt: this ticket was created ${String(days)} days ago. If you did not make it just now, delete it wherever you sent it and share a new one.`,
    hashCacheCleared: "Syncrypt: re-hashing the vault — this sync will take longer than usual.",
    storageAccepted:
      "Syncrypt: storage accepted. The next sync compares both sides from scratch — anything that differs is kept as a conflict copy.",
    notRolledBack: "Syncrypt: the storage is not behind this device — nothing to accept.",
  },

  commands: {
    syncNow: "Sync now",
    unlock: "Unlock (enter passphrase)",
    lock: "Lock (forget keys)",
    showLog: "Show sync log",
    shareConnection: "Share connection (create a ticket for another device)",
    addDevice: "Add this device from a ticket",
    rehashVault: "Re-hash the vault (forget cached file hashes)",
    reviewManifest: "Review manifest entries this device does not carry",
    reclaimStorage: "Reclaim storage (delete unreferenced objects)",
    acceptStorage: "Accept the storage as it is (after restoring a backup)",
  },

  settings: {
    version: (v: string) => `version ${v}`,
    syncNow: "Sync now",
    showLog: "Show sync log",
    unlockedName: "Unlocked",
    lockedName: "Locked",
    unlockedDesc: "Keys are in memory for this session.",
    lockedDesc: "Enter your passphrase to start syncing. It is never stored.",
    lockButton: "Lock",
    unlockButton: "Unlock…",

    interfaceHeading: "Interface",
    language: "Language",
    languageDesc: "Follow Obsidian's language, or pin one.",
    languageAuto: "Follow Obsidian",
    languageEn: "English",
    languageRu: "Русский",

    storageHeading: "Storage",
    provider: "Provider",
    providerDesc:
      "Which kind of storage this vault lives on. Switching keeps the other provider's settings, and locks the vault so the next unlock connects to the new one.",
    providerS3: "S3-compatible (R2, MinIO, Backblaze, AWS…)",
    providerWebdav: "WebDAV (Nextcloud, ownCloud, Apache…)",
    webdavUrl: "Collection URL",
    webdavUsername: "Username",
    webdavPassword: "Password",
    webdavAppPasswordHint:
      "Use an app password where your server offers one (Nextcloud: Settings → Security → Devices & sessions). It can be revoked on its own, and it is not your account password.",
    webdavNoConditionalWrites:
      "WebDAV cannot do conditional writes, so two devices publishing at the same instant are resolved after the fact instead of being prevented. Nothing is lost — the loser re-plans and reports its conflicts — but on S3 that race cannot happen at all.",
    plaintextWebdavWarning:
      "This URL is plain http://. Your notes are encrypted before they leave, but WebDAV Basic auth sends your username and password on EVERY request, in the clear. Use https://.",
    plaintextEndpointWarning:
      "This endpoint is plain http://. Your vault stays encrypted, but the storage credentials travel in the clear and anyone on the network can take them. Use https:// unless the server is on this machine.",
    credentialWarning:
      "Storage keys are saved in this plugin's data.json in plain text. Use keys limited to this one bucket, and turn on bucket versioning. Your notes stay protected by the passphrase, which is never written to disk.",
    endpoint: "Endpoint",
    region: "Region",
    bucket: "Bucket",
    prefix: "Prefix",
    prefixPlaceholder: "vaults/main (optional)",
    accessKeyId: "Access key ID",
    secretAccessKey: "Secret access key",
    pathStyle: "Path-style addressing",
    pathStyleDesc: "Keep on for MinIO/R2/self-hosted; some AWS setups need it off.",

    devicesHeading: "Devices",
    shareConnection: "Share connection",
    shareConnectionDesc:
      "Create an encrypted ticket with these storage settings for another device.",
    shareConnectionButton: "Create ticket…",
    addDevice: "Add this device from a ticket",
    addDeviceDesc: "Paste a ticket created on your other device to copy its settings here.",
    addDeviceButton: "Paste ticket…",

    profileHeading: "What gets synced",
    profileIntro:
      "Syncrypt syncs the contents of your vault: notes, attachments and folders. Anything starting with a dot — including .obsidian with its settings, plugins and themes — is never synced. Leave these fields alone unless you want to narrow that down.",
    include: "Include",
    includeDesc:
      "Path patterns, one per line. ** = everything (the default). Examples: **/*.md — notes only; Projects/** — one folder only.",
    exclude: "Exclude",
    excludeDesc:
      "Path patterns to skip, one per line, applied after Include. Examples: Archive/** — skip a folder; **/*.pdf — skip a file type.",
    configSyncHeading: "Obsidian settings sync",
    configSyncIntro:
      "Off by default. When on, the chosen settings files travel with your notes — encrypted like everything else. Plugin CODE is never synced: install plugins from the store as usual, this only carries their settings. Three things never leave this device: Syncrypt's own keys, your window layout, and the sync-trash.",
    configSyncEnabled: "Sync Obsidian settings",
    configSyncEnabledDesc:
      "A restart of Obsidian is needed on the receiving device before changed settings take effect.",
    configAppearance: "Appearance",
    configAppearanceDesc: "Theme choice, font sizes, enabled snippets (appearance.json).",
    configApp: "Editor and files",
    configAppDesc: "Editor and file-handling options (app.json). Some values are device-specific.",
    configHotkeys: "Hotkeys",
    configHotkeysDesc: "Your custom shortcuts (hotkeys.json).",
    configThemes: "Themes",
    configThemesDesc: "Installed themes.",
    configSnippets: "CSS snippets",
    configSnippetsDesc: "Your snippets folder.",
    configCorePlugins: "Core plugins list",
    configCorePluginsDesc: "Which built-in plugins are enabled.",
    configCommunityList: "Community plugins list",
    configCommunityListDesc:
      "Which third-party plugins are enabled — the list only, never the plugins themselves. You install each plugin on every device yourself; one that is not installed here simply stays off.",
    configPluginsHeading: "Plugin settings",
    configPluginsIntro:
      "Pick the plugins whose settings should travel. Only each plugin's data.json is synced — never the plugin's code, so install the plugin on every device first. Keep the versions aligned: a newer version may write settings an older one cannot read.",
    configPluginSecret: "may store API keys",
    configPluginSecretWarning: (name: string) =>
      `${name} is known to keep API keys or passwords in its settings — they will be uploaded (encrypted) and land on your other devices.`,
    configNoPlugins: "No third-party plugins installed.",
    configPluginsLoading: "Reading the plugin list…",
    profileCheck: "What matches now",
    profileCheckButton: "Count files",
    profileCheckDesc: "Count the files the current patterns would sync, without syncing anything.",
    profileCheckResult: (files: number, notes: number, attachments: number) =>
      `The profile matches ${String(files)} files: ${String(notes)} notes, ${String(attachments)} attachments.`,
    languageDetected: (detail: string) => `Obsidian reports — ${detail}`,

    safeSyncHeading: "Safe Sync",
    confirmationFloor: "Confirmation floor",
    confirmationFloorDesc:
      "Destructive changes at or below this count never prompt (0 = strict).",
    alwaysConfirmAt: "Always confirm at",
    alwaysConfirmAtDesc: "Destructive changes at or above this count always prompt.",
    vaultFraction: "Vault fraction",
    vaultFractionDesc:
      "Between floor and cap, prompt when the change exceeds this fraction (0.1 = 10%).",
    tombstoneGrace: "Forget a deletion after (days)",
    tombstoneGraceDesc:
      "How long the manifest remembers that a file was deleted. 0 = for ever. Shorten it and a device that has been offline longer than this brings its copies of those files back.",
    reclaimGrace: "Reclaim safety window (hours)",
    reclaimGraceDesc:
      "How long an object must have been referenced by nothing before it can be deleted. The window is what makes deletion safe against a sync that is in flight — do not shorten it below an hour.",
    generationsToKeep: "Manifest generations to keep",
    generationsToKeepDesc:
      "Older generations are pruned when you reclaim storage. They are the point-in-time history beyond each file's retained versions.",
    deletionBurstWindow: "Deletion burst window (seconds)",
    deletionBurstWindowDesc:
      "Deletions that arrive from one device inside this window count as ONE event. Deleting notes one at a time over a day no longer counts as a bulk change; a wipe, which lands all at once, still does.",
    versionsToKeep: "Versions to keep",
    versionsToKeepDesc: "Prior encrypted versions retained per changed file.",

    vaultCreationHeading: "Vault creation",
    kdfProfile: "Vault KDF profile",
    kdfProfileDesc:
      "Used only when THIS device creates the vault. Cross-device (default) is joinable from phones; desktop-only is stronger but mobile devices will refuse to join it.",
    kdfCrossDevice: "Cross-device (recommended)",
    kdfDesktopOnly: "Desktop-only (128 MiB Argon2id)",

    autoSyncHeading: "Auto-sync",
    syncWhileEditing: "Sync while editing",
    syncWhileEditingDesc: "Debounced sync after edits settle; manual Sync now always works.",
    wifiOnly: "Wi-Fi only",
    wifiOnlyDesc: "Skip automatic syncs on cellular data (manual Sync now always works).",
    debounce: "Debounce (seconds)",
    debounceDesc: "Quiet time after the last edit before an auto-sync.",
    periodicPull: "Pull every (seconds)",
    periodicPullDesc:
      "While Obsidian is open, check for other devices' changes on a timer even if nothing changed here. 0 turns it off.",
    minInterval: "Minimum interval (seconds)",
    minIntervalDesc: "At most one auto-sync per this many seconds.",

    deviceId: "Device ID",
    deviceIdDesc: (id: string) => `${id} — stable identifier used in manifests.`,
    copy: "Copy",
  },

  unlockModal: {
    title: "Unlock Syncrypt",
    intro:
      "Your passphrase decrypts this vault. It is never stored — keys live in memory until Obsidian closes or you lock.",
    passphrase: "Passphrase",
    unlock: "Unlock",
    checking: "Checking…",
    wrongPassphrase:
      "That passphrase does not open this vault. Nothing was changed.\nCheck your keyboard layout and Caps Lock, then try again.",
    manifestCorrupt:
      "The vault index in storage could not be read. Your local notes are untouched — check the sync log before syncing.",
    keyfileMissing:
      "The storage holds this vault's data but not the key file that opens it, so nothing was created or changed. Check the endpoint, bucket and prefix in Settings; if they are right, restore meta/keyfile-params.json from a backup before syncing.",
    storageUnauthorized:
      "The storage rejected these keys. The passphrase was not the problem — check the access keys and the bucket in Settings.",
    storageUnreachable:
      "Could not reach the storage. The passphrase was not the problem — check the endpoint, the bucket and your connection.",
    otherFailure: (detail: string) => `Could not unlock: ${detail}`,
  },

  confirmModal: {
    title: "Syncrypt: confirmation required",
    fallbackReason: "This sync makes bulk changes.",
    deleteLocal: "delete locally (to trash)",
    deleteRemote: "delete remotely (tombstone)",
    overwriteLocal: "overwrite local file",
    cancel: "Cancel (do nothing)",
    apply: "Apply changes",
  },

  shareModal: {
    title: "Share connection (add another device)",
    intro:
      "Creates an encrypted ticket with this device's storage settings. The ticket is exactly as strong as your passphrase — it is useless without it, but a weak passphrase makes it a weak ticket.",
    includeCreds: "Include storage credentials",
    includeCredsDesc: "Off = the other device types the keys manually (config only).",
    passphrase: "Vault passphrase",
    generate: "Generate ticket",
    resultTitle: "Your connection ticket",
    resultIntro:
      "On the other device: install Syncrypt, run “Add this device from a ticket”, paste this, and enter the same passphrase. Then DELETE the message you used to transfer it — treat the ticket like a secret.",
    copy: "Copy to clipboard",
  },

  addDeviceModal: {
    title: "Add this device from a ticket",
    intro: "Paste the connection ticket from your other device and enter your vault passphrase.",
    ticketPlaceholder: "Connection ticket…",
    passphrase: "Vault passphrase",
    connect: "Connect",
  },

  migration: {
    enabled: (name: string) =>
      `${name} is ENABLED in this vault. Two sync systems on one vault will fight over files — disable it before syncing with Syncrypt (see the migration guide).`,
    leftovers: (name: string, id: string) =>
      `${name} leftovers found (.obsidian/plugins/${id}). It is disabled, but "start clean" is the safe default — consider removing them (see the migration guide).`,
  },
};

/** The contract every language must satisfy — derived from English. */
export type Strings = typeof EN;

const RU: Strings = {
  status: {
    lockedLabel: "Syncrypt: заблокировано",
    lockedTooltip: "Введите парольную фразу, чтобы начать синхронизацию.",
    syncingLabel: (progress: string) => `Syncrypt: синхронизация${progress}`,
    syncingTooltip: "Идёт синхронизация.",
    offlineLabel: "Syncrypt: нет связи",
    offlineTooltip:
      "Хранилище недоступно. Правки сохранены локально и уйдут, как только связь вернётся.",
    errorLabel: "Syncrypt: ошибка",
    errorTooltip: "Последняя синхронизация не удалась — откройте журнал.",
    rolledBackLabel: "Syncrypt: хранилище откатилось",
    rolledBackTooltip:
      "Синхронизация отклоняется: в хранилище состояние старее того, что уже было на этом устройстве. Ничего не изменено — откройте журнал.",
    conflictLabel: (n: number) => `Syncrypt: конфликтов ${String(n)}`,
    conflictTooltip: (n: number) =>
      `Конфликтов: ${String(n)}. Обе версии сохранены — сведите их и синхронизируйте снова.`,
    conflictPaths: (shown: string[], more: number) =>
      `\n${shown.join(" · ")}${more > 0 ? ` … и ещё ${String(more)}` : ""}`,
    syncedLabel: "Syncrypt: синхронизировано ✓",
    syncedTooltip: "Всё синхронизировано.",
    pendingLabel: "Syncrypt: есть несохранённое",
    pendingNoSyncYet: "В этой сессии синхронизация ещё не завершалась.",
    pendingDirty: (n: number) => `Локальных изменений не выгружено: ${String(n)}.`,
    pendingNeedsConfirmation: "Массовое изменение ждёт вашего подтверждения.",
    pendingUnclean: "Последняя синхронизация завершилась не полностью.",
    factsLastSync: (time: string) => `последняя синхронизация ${time}`,
    factsCounts: (notes: number, attachments: number) =>
      `заметок ${String(notes)}, вложений ${String(attachments)}`,
    factsGeneration: (generation: number) => `поколение №${String(generation)}`,
    unlocking: "Syncrypt: разблокировка…",
    waitingForWifi: "Syncrypt: ожидание Wi-Fi",
    statusPrefix: "Статус: ",
  },

  reasons: {
    [ReasonCode.NewLocalFile]: "новый локальный файл → выгружен",
    [ReasonCode.LocalChanged]: "локальная версия изменилась → выгружена",
    [ReasonCode.RemoteNewer]: "в хранилище версия новее → загружена",
    [ReasonCode.NewRemoteFile]: "новый файл в хранилище → загружен",
    [ReasonCode.DeletedRemotely]: "помечен удалённым в манифесте → удалён локально",
    [ReasonCode.DeletedLocally]: "удалён локально → помечен удалённым в хранилище",
    [ReasonCode.ConflictBothChanged]: "изменён с обеих сторон → конфликт (не сливаем)",
    [ReasonCode.ConflictSamePath]: "один путь создан независимо → конфликт",
    [ReasonCode.ConflictEditDelete]: "с одной стороны правка, с другой удаление → конфликт",
    [ReasonCode.ConvergedNoop]: "уже синхронизировано → делать нечего",
  },

  log: {
    viewTitle: "Журнал Syncrypt",
    heading: "Журнал синхронизации",
    empty: "Пока ничего не синхронизировано.",
    unlocked: "Syncrypt разблокирован.",
    freshVault: "В хранилище пока нет манифеста — первая синхронизация его создаст.",
    verifyOffline:
      "Разблокировано без связи с хранилищем — парольную фразу проверить пока не удалось; работать можно, проверка произойдёт при следующей синхронизации.",
    locked: "Syncrypt заблокирован — ключи забыты.",
    configureFirst: "Syncrypt: укажите хранилище в настройках и разблокируйте.",
    unlockFailed: (detail: string) => `Разблокировка не удалась: ${detail}`,
    syncFailed: (detail: string) => `Синхронизация не удалась: ${detail}`,
    bulkCancelled: "Массовое изменение НЕ применено — вы отменили его.",
    configSyncAdopted: (summary: string) =>
      `Синхронизация настроек Obsidian: применён общий профиль хранилища (${summary}).`,
    ticketAge: (when: string, days: number) =>
      `Тикет подключения принят. Создан ${when} (${String(days)} дн. назад) — удали переданную копию.`,
    configSyncPublished:
      "Синхронизация настроек Obsidian: профиль этого устройства опубликован для остальных.",
    configSyncUnreadable:
      "Синхронизация настроек Obsidian: файл общего профиля прочитать не удалось — оставляю настройки этого устройства.",
    configSyncConflicted: (sharedPath: string, copyPath: string | undefined) =>
      copyPath === undefined
        ? `Синхронизация настроек Obsidian: «${sharedPath}» изменили на двух устройствах — это устройство оставило свои настройки, ничего не перезаписано. Задайте здесь нужные настройки, и это устройство опубликует их для остальных.`
        : `Синхронизация настроек Obsidian: «${sharedPath}» изменили на двух устройствах. Это устройство оставило свои настройки, чужая версия лежит рядом как «${copyPath}». Оба файла — в папке, которую Obsidian не показывает в списке файлов: сравните их файловым менеджером или просто задайте здесь нужные настройки, и это устройство опубликует их для остальных.`,
    conflictsFound: (shown: string[], more: number) =>
      `Конфликты — обе версии сохранены, ничего не перезаписано. Сведите их вручную и синхронизируйте снова: ${shown.join(", ")}${more > 0 ? ` … и ещё ${String(more)}` : ""}`,
    hashCacheCleared: "Кэш хешей очищен — следующий скан один раз перечитает всё хранилище.",
  },

  reclaimModal: {
    title: "Освободить место в хранилище",
    nothing:
      "Освобождать нечего: на все хранимые объекты кто-то ссылается, старых поколений манифеста для удаления тоже нет.",
    ready: (objects: number, size: string) =>
      `Объектов, на которые не ссылается ничто и защитное окно для которых прошло: ${String(objects)} (${size}).`,
    alsoManifests: (manifests: number) =>
      `Заодно будет убрано старых поколений манифеста: ${String(manifests)}. Восстановление на момент времени останется доступным по свежим поколениям и по сохранённым версиям каждого файла.`,
    waiting: (objects: number, size: string, when: string) =>
      `Объектов, на которые не ссылается ничто, но защитное окно ещё не прошло: ${String(objects)} (${size}). Запустите команду снова после ${when} — и их можно будет удалить.`,
    marked:
      "Они помечены вместе со временем, когда их впервые увидели ненужными: повторный запуск команды до срока не сбрасывает им отсчёт.",
    danger:
      "Это единственное, что Syncrypt делает без возможности отката. Удалённый объект исчезает: ни корзины, ни сохранённой версии, ни устройства, которое вернёт его обратно. Безопасно это потому, что кандидатом никогда не станет то, на что ссылается хоть один сохраняемый манифест, — и проверяется это заново в момент удаления, а не берётся из этого предпросмотра.",
    cancel: "Отмена",
    confirm: "Освободить",
    close: "Закрыть",
    done: (deleted: number, freed: string) =>
      `Syncrypt: удалено объектов — ${String(deleted)}, освобождено ${freed}.`,
    noneYet: (when: string) =>
      `Syncrypt: удалять пока нечего — объекты помечены, их можно будет убрать после ${when}.`,
  },

  acceptStorageModal: {
    title: "Принять хранилище как есть",
    what: (remote: number, base: number) =>
      `В хранилище поколение ${String(remote)}. Это устройство последний раз синхронизировалось с поколением ${String(base)}, значит из хранилища пропали манифесты. Пока вы не решите, что именно произошло, синхронизация отклоняется.`,
    restored:
      "Если вы сами восстанавливали хранилище из бэкапа или чистили его — так и должно быть: примите, и синхронизация продолжится с восстановленного состояния.",
    notRestored:
      "Если нет — НЕ принимайте. Любой, у кого есть доступ на запись, может так откатить все ваши устройства. Сначала разберитесь, у кого этот доступ есть; здесь пока ничего не изменено.",
    effect:
      "Принятие стирает только то, что это устройство помнит о прошлой синхронизации. Ни один файл не удаляется и ничего не загружается: следующая синхронизация сверит обе стороны с нуля, сохранит обе версии всего расходящегося как конфликт и не удалит ничего.",
    cancel: "Отмена",
    confirm: "Принять хранилище",
  },

  forgetModal: {
    title: "Файлы в манифесте, которых нет на этом устройстве",
    intro: (n: number) =>
      `В манифесте хранилища есть записи (${String(n)}), не попадающие в профиль синхронизации этого устройства. Часть из них жива на другом устройстве, часть могла остаться от профиля, которым больше никто не пользуется. Отличить может только человек.`,
    safety:
      "Забыть — не значит удалить: ни один файл не трогается и удаление нигде не записывается. Устройство, которое ещё носит путь, просто вернёт его на следующей синхронизации.",
    empty: "Разбирать нечего — это устройство носит всё, что есть в манифесте.",
    cancel: "Отмена",
    forget: (n: number) => (n === 0 ? "Забыть отмеченные" : `Забыть отмеченные: ${String(n)}`),
    noneFound: "Syncrypt: это устройство носит весь манифест — чистить нечего.",
    done: (n: number) =>
      `Syncrypt: забыто записей — ${String(n)}. То, что ещё носит другое устройство, вернётся на его следующей синхронизации.`,
    raced: "Syncrypt: другое устройство опубликовало изменения первым — ничего не изменено. Синхронизируйтесь и повторите.",
  },

  engine: {
    syncOutcome: {
      applied: "Синхронизация завершена: изменения применены.",
      "pull-first": "Синхронизация остановлена — сначала нужно скачать изменения.",
      "needs-confirmation": "Синхронизация остановлена — жду вашего подтверждения.",
      conflicts: "Синхронизация завершена с конфликтами — обе версии сохранены.",
      "no-op": "Синхронизация завершена: делать было нечего.",
      aborted: "Синхронизация прервана — ничего не осталось применённым наполовину.",
      "rolled-back": "Синхронизация отклонена — в хранилище состояние старее, чем на этом устройстве.",
    },
    pullFirst:
      "Синхронизация остановлена. Сначала скачайте изменения — другое устройство опубликовало более новую версию.",
    confirmationRequired: (destructive: number, total: number) =>
      `Жду подтверждения: эта синхронизация удалит или перезапишет ${String(destructive)} из ${String(total)} локальных файлов.`,
    confirmationRequiredPlain: "Жду вашего подтверждения — до него ничего не применяется.",
    confirmationStale: (n: number) =>
      `План изменился после вашего подтверждения (новых разрушающих операций: ${String(n)}) — подтвердите заново.`,
    stateUnreadable: (detail: string) =>
      `Локальное состояние синхронизации не читается — сверяюсь с нуля: медленнее, но безопасно (${detail}).`,
    dedupProbeUnavailable: (path: string, detail: string) =>
      `Не удалось проверить, есть ли «${path}» в хранилище — загружаю на всякий случай (${detail}).`,
    manifestEntriesForgotten: (count: number, generation: number) =>
      `Забыто записей манифеста: ${String(count)} (поколение ${String(generation)}). Ни один файл не удалён; устройство, которое ещё носит запись, вернёт её.`,
    vaultWrittenByNewer: (writer: string, self: string) =>
      `Это хранилище последним публиковал Syncrypt ${writer}, а на этом устройстве ${self}. Обнови это устройство, прежде чем делать здесь что-то серьёзное: более новая версия пишет то, что старая может прочитать иначе.`,
    vaultWrittenByOlder: (writer: string | undefined, self: string) =>
      `На другом устройстве ${writer === undefined || writer === "" ? "более старый Syncrypt" : `Syncrypt ${writer}`}, на этом — ${self}. Синхронизация работает, но пока обновлены не все устройства, ведут себя они по-разному — обнови остальные, когда сможешь.`,
    forkLost: (generation: number) =>
      `Два устройства опубликовали поколение ${String(generation)} в один момент, и это устройство не выиграло (ADR-0006 §4). Его собственная версия этого поколения — не та, которую прочитают остальные, поэтому синхронизация сверяется с опубликованной, а не с ней. Расходящиеся файлы вернутся конфликтами, обе версии сохранятся; ничего не перезаписывается, но и удаления, сделанные примерно тогда же, могут вернуться.`,
    tombstonesExpired: (count: number, days: number) =>
      `Из манифеста убрано записей об удалении старше ${String(days)} дн.: ${String(count)} (ADR-0031). Сами файлы остаются удалёнными — исчезла только запись о том, что их удалили. Устройство, простоявшее офлайн дольше этого срока, вернёт свои копии; если так случится, удалите их ещё раз.`,
    storageReclaimed: (deleted: number, freed: string, manifests: number, waiting: number) =>
      `Хранилище очищено: удалено объектов — ${String(deleted)} (${freed}), убрано старых поколений манифеста — ${String(manifests)}, ждут окончания защитного окна — ${String(waiting)}.`,
    storageRolledBack: (remote: number, base: number) =>
      `Синхронизация отклонена: в хранилище поколение ${String(remote)}, а это устройство уже синхронизировалось с поколением ${String(base)} (ADR-0038). Поколения только растут, значит манифесты пропали — восстановление из старого бэкапа, чистка или кто-то с правом записи в хранилище. Применить это означало бы тихо вернуть на место старые копии всех файлов. Ничего не изменено. Если вы восстанавливали хранилище сами — выполните команду «Принять хранилище как есть» и синхронизируйтесь заново; если нет — сначала разберитесь, у кого есть доступ на запись.`,
    deletionsPaced: (paced: number, spanSeconds: number, destructive: number) =>
      `С другого устройства пришло удалений: ${String(paced)}, растянутых на ${spanRu(spanSeconds)} — это темп работы человека, а не сбоя, поэтому подтверждение на ${String(destructive)} разрушающих изменений не запрашивалось (ADR-0029). Удалённые файлы лежат в корзине синхронизации.`,
  },

  entryDetail: {
    conflictCopySaved: (copyPath: string) => `удалённая версия сохранена как «${copyPath}»`,
    remoteEditRestored:
      "восстановлена версия, изменённая на другом устройстве; удалите ещё раз, чтобы подтвердить",
    localEditKept: "локально изменённый файл оставлен на месте, он будет загружен заново",
  },

  notices: {
    fillSettingsFirst: "Syncrypt: сначала заполните настройки хранилища.",
    configureBeforeSharing: "Syncrypt: сначала настройте и проверьте хранилище.",
    unlockFailed: (detail: string) => `Syncrypt: разблокировка не удалась — ${detail}`,
    syncFailed: (detail: string) => `Syncrypt: синхронизация не удалась — ${detail}`,
    migrationWarnings: (n: number) =>
      `Syncrypt: предупреждений о миграции — ${String(n)}. Откройте журнал перед продолжением.`,
    conflicts: (n: number) =>
      `Syncrypt: конфликтов — ${String(n)}. Обе версии сохранены, подробности в журнале.`,
    conflictOne: (path: string) =>
      `Syncrypt: конфликт в «${path}» — обе версии сохранены, подробности в журнале.`,
    alreadyInSync: "Syncrypt: уже синхронизировано.",
    ticketCopied: "Тикет скопирован.",
    sharePassphraseWrong:
      "Syncrypt: эта парольная фраза не открывает хранилище — тикет на другом устройстве не заработает.",
    ticketRejected: (detail: string) => `Syncrypt: тикет отклонён — ${detail}`,
    ticketImportedNoCreds:
      "Настройки подключения импортированы БЕЗ ключей доступа — введите ключи в настройках и разблокируйте.",
    ticketImported:
      "Подключение импортировано. Соединяемся… (удалите переданный тикет из переписки)",
    deviceIdCopied: "Идентификатор устройства скопирован",
    configSyncAdopted: "Syncrypt: профиль настроек Obsidian обновлён с другого устройства.",
    configSyncSecretPlugins: (names: string) =>
      `Syncrypt: другое устройство включило синхронизацию настроек для ${names} — эти плагины могут хранить ключи API в data.json. Если не нужно — выключите здесь.`,
    ticketOld: (days: number) =>
      `Syncrypt: этому тикету ${String(days)} дн. Если ты не создавал его только что — удали его там, куда отправлял, и поделись новым.`,
    hashCacheCleared: "Syncrypt: пересчитываю хеши хранилища — эта синхронизация будет дольше обычной.",
    storageAccepted:
      "Syncrypt: хранилище принято. Следующая синхронизация сверит обе стороны с нуля — всё расходящееся сохранится как конфликт.",
    notRolledBack: "Syncrypt: хранилище не отстаёт от этого устройства — принимать нечего.",
  },

  commands: {
    syncNow: "Синхронизировать сейчас",
    unlock: "Разблокировать (ввести парольную фразу)",
    lock: "Заблокировать (забыть ключи)",
    showLog: "Открыть журнал синхронизации",
    shareConnection: "Поделиться подключением (создать тикет для другого устройства)",
    addDevice: "Добавить это устройство по тикету",
    rehashVault: "Пересчитать хеши хранилища (забыть кэш)",
    reviewManifest: "Разобрать записи манифеста, которых нет на этом устройстве",
    reclaimStorage: "Освободить место в хранилище (удалить ненужные объекты)",
    acceptStorage: "Принять хранилище как есть (после восстановления из бэкапа)",
  },

  settings: {
    version: (v: string) => `версия ${v}`,
    syncNow: "Синхронизировать сейчас",
    showLog: "Открыть журнал",
    unlockedName: "Разблокировано",
    lockedName: "Заблокировано",
    unlockedDesc: "Ключи находятся в памяти до конца сессии.",
    lockedDesc: "Введите парольную фразу, чтобы начать синхронизацию. Она нигде не сохраняется.",
    lockButton: "Заблокировать",
    unlockButton: "Разблокировать…",

    interfaceHeading: "Интерфейс",
    language: "Язык",
    languageDesc: "Следовать языку Obsidian или задать явно.",
    languageAuto: "Как в Obsidian",
    languageEn: "English",
    languageRu: "Русский",

    storageHeading: "Хранилище",
    provider: "Провайдер",
    providerDesc:
      "На каком хранилище живёт это хранилище заметок. Переключение сохраняет настройки второго провайдера и блокирует хранилище: следующая разблокировка подключится уже к новому.",
    providerS3: "S3-совместимое (R2, MinIO, Backblaze, AWS…)",
    providerWebdav: "WebDAV (Nextcloud, ownCloud, Apache…)",
    webdavUrl: "URL коллекции",
    webdavUsername: "Имя пользователя",
    webdavPassword: "Пароль",
    webdavAppPasswordHint:
      "Если сервер умеет пароли приложений — используйте их (Nextcloud: Настройки → Безопасность → Устройства и сеансы). Такой пароль отзывается отдельно и не является паролем от аккаунта.",
    webdavNoConditionalWrites:
      "WebDAV не умеет условную запись, поэтому два устройства, опубликовавшие изменения в один момент, разбираются постфактум, а не предотвращаются. Ничего не теряется — проигравший перепланирует и покажет конфликты, — но на S3 такой гонки не бывает вовсе.",
    plaintextWebdavWarning:
      "Этот URL — обычный http://. Заметки шифруются до отправки, но WebDAV Basic auth шлёт имя пользователя и пароль в КАЖДОМ запросе, открытым текстом. Используйте https://.",
    plaintextEndpointWarning:
      "Этот адрес — обычный http://. Само хранилище остаётся зашифрованным, но ключи доступа идут по сети открытым текстом, и забрать их может любой в этой сети. Используйте https://, если сервер не на этой же машине.",
    credentialWarning:
      "Ключи доступа сохраняются в data.json этого плагина открытым текстом. Используйте ключи, ограниченные одним бакетом, и включите версионирование бакета. Сами заметки защищены парольной фразой, которая на диск не пишется.",
    endpoint: "Адрес (endpoint)",
    region: "Регион",
    bucket: "Бакет",
    prefix: "Префикс",
    prefixPlaceholder: "vaults/main (необязательно)",
    accessKeyId: "Access key ID",
    secretAccessKey: "Secret access key",
    pathStyle: "Path-style адресация",
    pathStyleDesc: "Оставьте включённой для MinIO/R2/своего сервера; части настроек AWS нужна выключенной.",

    devicesHeading: "Устройства",
    shareConnection: "Поделиться подключением",
    shareConnectionDesc:
      "Создать зашифрованный тикет с этими настройками хранилища для другого устройства.",
    shareConnectionButton: "Создать тикет…",
    addDevice: "Добавить это устройство по тикету",
    addDeviceDesc: "Вставьте тикет, созданный на другом устройстве, чтобы перенести настройки сюда.",
    addDeviceButton: "Вставить тикет…",

    profileHeading: "Что синхронизируется",
    profileIntro:
      "Syncrypt синхронизирует содержимое хранилища: заметки, вложения и папки. Всё, что начинается с точки — включая .obsidian с настройками, плагинами и темами — не синхронизируется никогда. Эти поля нужны, только если вы хотите сузить набор файлов.",
    include: "Включать",
    includeDesc:
      "Шаблоны путей, по одному в строке. ** — всё (по умолчанию). Примеры: **/*.md — только заметки; Проекты/** — только одна папка.",
    exclude: "Исключать",
    excludeDesc:
      "Шаблоны путей, которые пропустить; применяются после «Включать». Примеры: Архив/** — пропустить папку; **/*.pdf — пропустить тип файлов.",
    configSyncHeading: "Синхронизация настроек Obsidian",
    configSyncIntro:
      "По умолчанию выключено. Когда включено, выбранные файлы настроек едут вместе с заметками — так же зашифрованными. Код плагинов не синхронизируется никогда: плагины ставятся из стора как обычно, сюда едут только их настройки. Три вещи не покидают это устройство никогда: ключи самого Syncrypt, раскладка окон и корзина синхронизации.",
    configSyncEnabled: "Синхронизировать настройки Obsidian",
    configSyncEnabledDesc:
      "Чтобы изменившиеся настройки вступили в силу, Obsidian на принимающем устройстве нужно перезапустить.",
    configAppearance: "Внешний вид",
    configAppearanceDesc: "Выбранная тема, размеры шрифтов, включённые сниппеты (appearance.json).",
    configApp: "Редактор и файлы",
    configAppDesc:
      "Настройки редактора и работы с файлами (app.json). Часть значений привязана к устройству.",
    configHotkeys: "Горячие клавиши",
    configHotkeysDesc: "Ваши сочетания клавиш (hotkeys.json).",
    configThemes: "Темы",
    configThemesDesc: "Установленные темы.",
    configSnippets: "CSS-сниппеты",
    configSnippetsDesc: "Папка со сниппетами.",
    configCorePlugins: "Список основных плагинов",
    configCorePluginsDesc: "Какие встроенные плагины включены.",
    configCommunityList: "Список сторонних плагинов",
    configCommunityListDesc:
      "Какие сторонние плагины включены — только список, сами плагины не переезжают. Каждый плагин нужно установить на каждом устройстве вручную; не установленный здесь просто останется выключенным.",
    configPluginsHeading: "Настройки плагинов",
    configPluginsIntro:
      "Отметьте плагины, чьи настройки должны переезжать. Едет только data.json — код плагина не синхронизируется, поэтому сам плагин сначала установите на каждом устройстве. Держите версии одинаковыми: более новая может записать настройки, которые старая не прочитает.",
    configPluginSecret: "может хранить ключи",
    configPluginSecretWarning: (name: string) =>
      `${name} известен тем, что хранит ключи или пароли в своих настройках — они уедут в хранилище (зашифрованными) и попадут на другие ваши устройства.`,
    configNoPlugins: "Сторонние плагины не установлены.",
    configPluginsLoading: "Читаю список плагинов…",
    profileCheck: "Что попадает сейчас",
    profileCheckButton: "Посчитать файлы",
    profileCheckDesc: "Посчитать файлы, которые попадут под текущие шаблоны, ничего не синхронизируя.",
    profileCheckResult: (files: number, notes: number, attachments: number) =>
      `Под профиль попадает файлов: ${String(files)} — заметок ${String(notes)}, вложений ${String(attachments)}.`,
    languageDetected: (detail: string) => `Obsidian сообщает — ${detail}`,

    safeSyncHeading: "Безопасная синхронизация",
    confirmationFloor: "Порог без подтверждения",
    confirmationFloorDesc:
      "Разрушающие изменения в этом количестве и меньше применяются без вопроса (0 = спрашивать всегда).",
    alwaysConfirmAt: "Всегда спрашивать при",
    alwaysConfirmAtDesc: "Разрушающие изменения в этом количестве и больше требуют подтверждения.",
    vaultFraction: "Доля хранилища",
    vaultFractionDesc:
      "Между порогом и верхней границей спрашивать, если изменение превышает эту долю (0.1 = 10%).",
    tombstoneGrace: "Забывать удаление через (дней)",
    tombstoneGraceDesc:
      "Сколько манифест помнит, что файл был удалён. 0 — помнить всегда. Если сократить, устройство, простоявшее офлайн дольше этого срока, вернёт свои копии таких файлов.",
    reclaimGrace: "Защитное окно очистки (часов)",
    reclaimGraceDesc:
      "Сколько объект должен простоять никому не нужным, прежде чем его можно удалить. Именно это окно делает удаление безопасным для синхронизации, идущей прямо сейчас, — не ставьте меньше часа.",
    generationsToKeep: "Хранить поколений манифеста",
    generationsToKeepDesc:
      "Более старые убираются при очистке хранилища. Это история на момент времени сверх сохранённых версий каждого файла.",
    deletionBurstWindow: "Окно всплеска удалений (секунды)",
    deletionBurstWindowDesc:
      "Удаления, пришедшие с одного устройства в пределах этого окна, считаются ОДНИМ событием. Удаление заметок по одной в течение дня перестаёт быть массовым изменением; разовое стирание, которое приходит целиком, им остаётся.",
    versionsToKeep: "Хранить версий",
    versionsToKeepDesc: "Сколько прошлых зашифрованных версий держать для изменённого файла.",

    vaultCreationHeading: "Создание хранилища",
    kdfProfile: "Профиль KDF хранилища",
    kdfProfileDesc:
      "Применяется только когда ЭТО устройство создаёт хранилище. Кросс-платформенный (по умолчанию) открывается с телефона; настольный надёжнее, но мобильные устройства к такому хранилищу не подключатся.",
    kdfCrossDevice: "Кросс-платформенный (рекомендуется)",
    kdfDesktopOnly: "Только настольный (Argon2id 128 МиБ)",

    autoSyncHeading: "Автосинхронизация",
    syncWhileEditing: "Синхронизировать во время работы",
    syncWhileEditingDesc:
      "Синхронизация с задержкой после того, как правки утихли; ручная всегда доступна.",
    wifiOnly: "Только по Wi-Fi",
    wifiOnlyDesc: "Не синхронизировать автоматически по мобильной сети (ручная всегда доступна).",
    debounce: "Задержка (секунды)",
    debounceDesc: "Сколько тишины после последней правки ждать до автосинхронизации.",
    periodicPull: "Проверять раз в (секунды)",
    periodicPullDesc:
      "Пока Obsidian открыт, забирать изменения с других устройств по таймеру, даже если здесь ничего не менялось. 0 — выключено.",
    minInterval: "Минимальный интервал (секунды)",
    minIntervalDesc: "Не чаще одной автосинхронизации за столько секунд.",

    deviceId: "Идентификатор устройства",
    deviceIdDesc: (id: string) => `${id} — постоянный идентификатор, используется в манифестах.`,
    copy: "Копировать",
  },

  unlockModal: {
    title: "Разблокировка Syncrypt",
    intro:
      "Парольная фраза расшифровывает это хранилище. Она нигде не сохраняется — ключи живут в памяти до закрытия Obsidian или блокировки.",
    passphrase: "Парольная фраза",
    unlock: "Разблокировать",
    checking: "Проверяю…",
    wrongPassphrase:
      "Эта парольная фраза не открывает хранилище. Ничего не изменилось.\nПроверьте раскладку и Caps Lock и попробуйте ещё раз.",
    manifestCorrupt:
      "Не удалось прочитать индекс хранилища. Локальные заметки не тронуты — загляните в журнал перед синхронизацией.",
    keyfileMissing:
      "В хранилище есть данные, но нет файла с параметрами ключа, который их открывает, — поэтому ничего не создано и не изменено. Проверьте адрес, бакет и префикс в настройках; если они верны, восстановите meta/keyfile-params.json из резервной копии перед синхронизацией.",
    storageUnauthorized:
      "Хранилище отклонило ключи доступа. Дело не в парольной фразе — проверьте ключи и бакет в настройках.",
    storageUnreachable:
      "Не удалось достучаться до хранилища. Дело не в парольной фразе — проверьте адрес, бакет и связь.",
    otherFailure: (detail: string) => `Не удалось разблокировать: ${detail}`,
  },

  confirmModal: {
    title: "Syncrypt: нужно подтверждение",
    fallbackReason: "Эта синхронизация вносит массовые изменения.",
    deleteLocal: "удалить локально (в корзину)",
    deleteRemote: "удалить в хранилище (пометка удаления)",
    overwriteLocal: "перезаписать локальный файл",
    cancel: "Отмена (ничего не делать)",
    apply: "Применить изменения",
  },

  shareModal: {
    title: "Поделиться подключением (добавить устройство)",
    intro:
      "Создаёт зашифрованный тикет с настройками хранилища этого устройства. Тикет ровно настолько же надёжен, насколько ваша парольная фраза: без неё он бесполезен, но слабая фраза делает слабым и тикет.",
    includeCreds: "Включить ключи доступа",
    includeCredsDesc: "Выключено — ключи придётся ввести на другом устройстве вручную.",
    passphrase: "Парольная фраза хранилища",
    generate: "Создать тикет",
    resultTitle: "Ваш тикет подключения",
    resultIntro:
      "На другом устройстве: установите Syncrypt, выполните «Добавить это устройство по тикету», вставьте текст и введите ту же парольную фразу. Затем УДАЛИТЕ сообщение, которым передали тикет — относитесь к нему как к секрету.",
    copy: "Копировать в буфер",
  },

  addDeviceModal: {
    title: "Добавить это устройство по тикету",
    intro:
      "Вставьте тикет подключения с другого устройства и введите парольную фразу хранилища.",
    ticketPlaceholder: "Тикет подключения…",
    passphrase: "Парольная фраза хранилища",
    connect: "Подключиться",
  },

  migration: {
    enabled: (name: string) =>
      `${name} ВКЛЮЧЁН в этом хранилище. Две системы синхронизации на одном хранилище будут драться за файлы — отключите его перед работой с Syncrypt (см. руководство по миграции).`,
    leftovers: (name: string, id: string) =>
      `Найдены остатки ${name} (.obsidian/plugins/${id}). Плагин выключен, но безопаснее начинать с чистого листа — их стоит удалить (см. руководство по миграции).`,
  },
};

const TABLES: Record<Lang, Strings> = { en: EN, ru: RU };

export function stringsFor(lang: Lang): Strings {
  return TABLES[lang];
}

/** English table, exported for defaults in pure modules and for tests. */
export const EN_STRINGS: Strings = EN;
