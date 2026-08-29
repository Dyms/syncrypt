// UI localization (ADR-0021). The engine stays language-agnostic: it emits
// stable `ReasonCode`s and typed errors, and the CLIENT decides how to phrase
// them. Nothing here reaches storage, the manifest, or the log's semantics —
// only what a human reads on screen.
//
// English is the source of truth: `Strings` is derived from `EN`, so a missing
// or renamed key fails `tsc` instead of silently falling back at runtime.

import { ReasonCode, type SyncOutcome } from "@syncrypt/core";

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
    conflictLabel: (n: number) => `Syncrypt: conflict (${String(n)})`,
    conflictTooltip: (n: number) =>
      `${String(n)} conflict(s) — both versions were kept; merge them and sync again.`,
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
    configSyncPublished:
      "Obsidian-settings sync: published this device's profile for the other devices.",
    configSyncUnreadable:
      "Obsidian-settings sync: the shared profile file could not be read — keeping this device's own settings.",
    configSyncConflicted:
      "Obsidian-settings sync: the shared profile was changed on two devices — this device kept its own and the other version is beside it as a conflicted copy. Check the settings.",
    hashCacheCleared: "Cached file hashes forgotten — the next scan re-reads the whole vault once.",
  },

  /**
   * Everything the engine reports, phrased here (ADR-0026). The engine hands
   * over a code and its facts; the wording is ours, in the reader's language.
   */
  engine: {
    syncOutcome: {
      applied: "Sync finished: changes applied.",
      "pull-first": "Sync stopped — pull first.",
      "needs-confirmation": "Sync stopped — waiting for your confirmation.",
      conflicts: "Sync finished with conflicts — both versions kept.",
      "no-op": "Sync finished: nothing to do.",
      aborted: "Sync interrupted — nothing was left half-applied.",
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
    alreadyInSync: "Syncrypt: already in sync.",
    ticketCopied: "Ticket copied.",
    ticketRejected: (detail: string) => `Syncrypt: ticket rejected — ${detail}`,
    ticketImportedNoCreds:
      "Connection settings imported WITHOUT credentials — enter the storage keys in Settings, then Unlock.",
    ticketImported: "Connection imported. Connecting… (delete the transferred ticket now)",
    deviceIdCopied: "Device ID copied",
    configSyncAdopted: "Syncrypt: Obsidian-settings profile updated from another device.",
    configSyncSecretPlugins: (names: string) =>
      `Syncrypt: another device turned on settings sync for ${names} — plugins that can keep API keys in data.json. Turn it off here if you would rather not.`,
    hashCacheCleared: "Syncrypt: re-hashing the vault — this sync will take longer than usual.",
  },

  commands: {
    syncNow: "Sync now",
    unlock: "Unlock (enter passphrase)",
    lock: "Lock (forget keys)",
    showLog: "Show sync log",
    shareConnection: "Share connection (create a ticket for another device)",
    addDevice: "Add this device from a ticket",
    rehashVault: "Re-hash the vault (forget cached file hashes)",
  },

  settings: {
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

    storageHeading: "Storage (S3-compatible)",
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
    versionsToKeep: "Versions to keep",
    versionsToKeepDesc: "Prior encrypted versions retained per changed file.",

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
    apply: (n: number) => `Apply ${String(n)} destructive changes`,
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
    conflictLabel: (n: number) => `Syncrypt: конфликтов ${String(n)}`,
    conflictTooltip: (n: number) =>
      `Конфликтов: ${String(n)}. Обе версии сохранены — сведите их и синхронизируйте снова.`,
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
    configSyncPublished:
      "Синхронизация настроек Obsidian: профиль этого устройства опубликован для остальных.",
    configSyncUnreadable:
      "Синхронизация настроек Obsidian: файл общего профиля прочитать не удалось — оставляю настройки этого устройства.",
    configSyncConflicted:
      "Синхронизация настроек Obsidian: общий профиль изменили на двух устройствах — это устройство оставило свой, чужая версия лежит рядом как conflicted copy. Проверьте настройки.",
    hashCacheCleared: "Кэш хешей очищен — следующий скан один раз перечитает всё хранилище.",
  },

  engine: {
    syncOutcome: {
      applied: "Синхронизация завершена: изменения применены.",
      "pull-first": "Синхронизация остановлена — сначала нужно скачать изменения.",
      "needs-confirmation": "Синхронизация остановлена — жду вашего подтверждения.",
      conflicts: "Синхронизация завершена с конфликтами — обе версии сохранены.",
      "no-op": "Синхронизация завершена: делать было нечего.",
      aborted: "Синхронизация прервана — ничего не осталось применённым наполовину.",
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
    alreadyInSync: "Syncrypt: уже синхронизировано.",
    ticketCopied: "Тикет скопирован.",
    ticketRejected: (detail: string) => `Syncrypt: тикет отклонён — ${detail}`,
    ticketImportedNoCreds:
      "Настройки подключения импортированы БЕЗ ключей доступа — введите ключи в настройках и разблокируйте.",
    ticketImported:
      "Подключение импортировано. Соединяемся… (удалите переданный тикет из переписки)",
    deviceIdCopied: "Идентификатор устройства скопирован",
    configSyncAdopted: "Syncrypt: профиль настроек Obsidian обновлён с другого устройства.",
    configSyncSecretPlugins: (names: string) =>
      `Syncrypt: другое устройство включило синхронизацию настроек для ${names} — эти плагины могут хранить ключи API в data.json. Если не нужно — выключите здесь.`,
    hashCacheCleared: "Syncrypt: пересчитываю хеши хранилища — эта синхронизация будет дольше обычной.",
  },

  commands: {
    syncNow: "Синхронизировать сейчас",
    unlock: "Разблокировать (ввести парольную фразу)",
    lock: "Заблокировать (забыть ключи)",
    showLog: "Открыть журнал синхронизации",
    shareConnection: "Поделиться подключением (создать тикет для другого устройства)",
    addDevice: "Добавить это устройство по тикету",
    rehashVault: "Пересчитать хеши хранилища (забыть кэш)",
  },

  settings: {
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

    storageHeading: "Хранилище (S3-совместимое)",
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
    versionsToKeep: "Хранить версий",
    versionsToKeepDesc: "Сколько прошлых зашифрованных версий держать для изменённого файла.",

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
    apply: (n: number) => `Применить разрушающих изменений: ${String(n)}`,
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
