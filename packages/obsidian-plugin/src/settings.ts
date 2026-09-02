// Plugin settings — persisted in data.json (ADR-0016: storage credentials
// live here BY DECISION, with a UI warning; the passphrase NEVER does).

import { DEFAULT_CONFIG_SYNC, type ConfigSyncSettings } from "./config-sync.js";
import type { LangSetting } from "./i18n.js";
import { DEFAULT_PROFILE, type SyncProfile } from "./profile.js";

/** The backends the plugin can talk to (ADR-0033). */
export type StorageProviderKind = "s3" | "webdav";

export interface SyncryptSettings {
  /** UI language; "auto" follows Obsidian's own setting (ADR-0021). */
  language: LangSetting;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  /**
   * Which backend this vault talks to (ADR-0033). Absent in settings written
   * before beta.10 — those vaults are S3 by definition, which is what
   * withDefaults() fills in.
   */
  provider: StorageProviderKind;
  webdav: {
    /** Collection URL that is the vault's storage root. */
    url: string;
    username: string;
    password: string;
    prefix: string;
  };
  profile: SyncProfile;
  /** Obsidian settings sync — opt-in, per-item (RFC-0008). */
  configSync: ConfigSyncSettings;
  safeSync: {
    bulkChangeFloor: number;
    bulkChangeMaxFiles: number;
    bulkChangeMaxFraction: number;
    /** Seconds within which deletions from one device are one burst (ADR-0029). */
    deletionBurstWindow: number;
    versionsToKeep: number;
    /** Tombstones older than this expire on push; 0 = never (ADR-0031). */
    tombstoneGraceSeconds: number;
    /** How long an object must sit unreferenced before a sweep (ADR-0030). */
    reclaimGraceSeconds: number;
    /** Manifest generations kept; reachability is computed from them (ADR-0030). */
    generationsToKeep: number;
  };
  autoSync: {
    enabled: boolean;
    debounceSec: number;
    minIntervalSec: number;
    /** Skip AUTO syncs on cellular (RFC-0004; default ON on mobile). */
    wifiOnly: boolean;
    /**
     * Pull on a timer while the app is open, so another device's work arrives
     * without an edit here to trigger it (RFC-0004 §Triggers). 0 = never.
     * Longer on mobile, where every wake-up costs battery.
     */
    periodicSec: number;
  };
  /** Vault-creation KDF profile (ADR-0018); affects only the FIRST device. */
  kdfProfile: "cross-device" | "desktop-only";
  /** Stable random per-device UUID (RFC-0007), generated on first run. */
  deviceId: string;
}

export interface PlatformDefaults {
  mobile: boolean;
}

export const DEFAULT_SETTINGS: SyncryptSettings = {
  language: "auto",
  s3: {
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    prefix: "",
    accessKeyId: "",
    secretAccessKey: "",
    forcePathStyle: true,
  },
  provider: "s3",
  webdav: {
    url: "",
    username: "",
    password: "",
    prefix: "",
  },
  profile: DEFAULT_PROFILE,
  configSync: DEFAULT_CONFIG_SYNC,
  safeSync: {
    bulkChangeFloor: 5,
    bulkChangeMaxFiles: 20,
    bulkChangeMaxFraction: 0.1,
    deletionBurstWindow: 300,
    versionsToKeep: 3,
    tombstoneGraceSeconds: 30 * 24 * 60 * 60,
    reclaimGraceSeconds: 24 * 60 * 60,
    generationsToKeep: 10,
  },
  autoSync: {
    enabled: true,
    debounceSec: 15,
    minIntervalSec: 30,
    wifiOnly: false,
    periodicSec: 900, // 15 min
  },
  kdfProfile: "cross-device",
  deviceId: "",
};

/**
 * Merge persisted data over platform-appropriate defaults. Mobile gets the
 * RFC-0004 resource-aware defaults: min interval 120 s and wifi-only ON —
 * only for fields the user has not explicitly saved.
 */
export function withDefaults(
  loaded: unknown,
  platform: PlatformDefaults = { mobile: false },
): SyncryptSettings {
  const raw = (typeof loaded === "object" && loaded !== null ? loaded : {}) as Partial<SyncryptSettings>;
  const autoSyncDefaults = platform.mobile
    ? { ...DEFAULT_SETTINGS.autoSync, minIntervalSec: 120, wifiOnly: true, periodicSec: 1800 }
    : DEFAULT_SETTINGS.autoSync;
  return {
    language:
      raw.language === "en" || raw.language === "ru" || raw.language === "auto"
        ? raw.language
        : DEFAULT_SETTINGS.language,
    s3: { ...DEFAULT_SETTINGS.s3, ...raw.s3 },
    // A vault configured before beta.10 has no `provider` and is S3 — the only
    // backend the UI could reach. Anything unrecognized falls back the same
    // way rather than leaving the plugin pointed at nothing.
    provider: raw.provider === "webdav" ? "webdav" : "s3",
    webdav: { ...DEFAULT_SETTINGS.webdav, ...raw.webdav },
    // Checked like every other field. A non-array here — a hand-edited
    // data.json, a half-written file — reached `new ProfileMatcher` and threw
    // inside unlock, with no way back except editing data.json by hand.
    profile: {
      include: globList(raw.profile?.include, DEFAULT_SETTINGS.profile.include),
      exclude: globList(raw.profile?.exclude, DEFAULT_SETTINGS.profile.exclude),
    },
    configSync: {
      ...DEFAULT_CONFIG_SYNC,
      ...raw.configSync,
      plugins: Array.isArray(raw.configSync?.plugins)
        ? raw.configSync.plugins.filter((x): x is string => typeof x === "string")
        : [],
    },
    safeSync: { ...DEFAULT_SETTINGS.safeSync, ...raw.safeSync },
    autoSync: { ...autoSyncDefaults, ...raw.autoSync },
    kdfProfile: raw.kdfProfile ?? DEFAULT_SETTINGS.kdfProfile,
    deviceId: raw.deviceId !== undefined && raw.deviceId !== "" ? raw.deviceId : generateDeviceId(),
  };
}

function globList(raw: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const clean = raw.filter((x): x is string => typeof x === "string");
  // An array that lost every entry to the filter is corrupt, not "sync
  // nothing": falling back is the direction that keeps a vault working.
  return clean.length > 0 || raw.length === 0 ? clean : [...fallback];
}

export function generateDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `dev-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Enough filled in to attempt a connection. Per provider: WebDAV needs a URL
 * and Basic credentials; S3 needs an endpoint, a bucket and a key pair.
 */
export function settingsComplete(s: SyncryptSettings): boolean {
  if (s.provider === "webdav") {
    return s.webdav.url !== "" && s.webdav.username !== "" && s.webdav.password !== "";
  }
  return (
    s.s3.endpoint !== "" &&
    s.s3.bucket !== "" &&
    s.s3.accessKeyId !== "" &&
    s.s3.secretAccessKey !== ""
  );
}

/** The URL whose scheme decides the plaintext-endpoint warning, per provider. */
export function endpointOf(s: SyncryptSettings): string {
  return s.provider === "webdav" ? s.webdav.url : s.s3.endpoint;
}

/** The storage key prefix for the active provider. */
export function storagePrefixOf(s: SyncryptSettings): string {
  return s.provider === "webdav" ? s.webdav.prefix : s.s3.prefix;
}
