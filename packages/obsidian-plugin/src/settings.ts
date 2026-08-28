// Plugin settings — persisted in data.json (ADR-0016: S3 credentials live
// here BY DECISION, with a UI warning; the passphrase NEVER does).

import { DEFAULT_CONFIG_SYNC, type ConfigSyncSettings } from "./config-sync.js";
import type { LangSetting } from "./i18n.js";
import { DEFAULT_PROFILE, type SyncProfile } from "./profile.js";

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
  profile: SyncProfile;
  /** Obsidian settings sync — opt-in, per-item (RFC-0008). */
  configSync: ConfigSyncSettings;
  safeSync: {
    bulkChangeFloor: number;
    bulkChangeMaxFiles: number;
    bulkChangeMaxFraction: number;
    versionsToKeep: number;
  };
  autoSync: {
    enabled: boolean;
    debounceSec: number;
    minIntervalSec: number;
    /** Skip AUTO syncs on cellular (RFC-0004; default ON on mobile). */
    wifiOnly: boolean;
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
  profile: DEFAULT_PROFILE,
  configSync: DEFAULT_CONFIG_SYNC,
  safeSync: {
    bulkChangeFloor: 5,
    bulkChangeMaxFiles: 20,
    bulkChangeMaxFraction: 0.1,
    versionsToKeep: 3,
  },
  autoSync: {
    enabled: true,
    debounceSec: 15,
    minIntervalSec: 30,
    wifiOnly: false,
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
    ? { ...DEFAULT_SETTINGS.autoSync, minIntervalSec: 120, wifiOnly: true }
    : DEFAULT_SETTINGS.autoSync;
  return {
    language:
      raw.language === "en" || raw.language === "ru" || raw.language === "auto"
        ? raw.language
        : DEFAULT_SETTINGS.language,
    s3: { ...DEFAULT_SETTINGS.s3, ...raw.s3 },
    profile: {
      include: raw.profile?.include ?? DEFAULT_SETTINGS.profile.include,
      exclude: raw.profile?.exclude ?? DEFAULT_SETTINGS.profile.exclude,
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

export function generateDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `dev-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function settingsComplete(s: SyncryptSettings): boolean {
  return (
    s.s3.endpoint !== "" &&
    s.s3.bucket !== "" &&
    s.s3.accessKeyId !== "" &&
    s.s3.secretAccessKey !== ""
  );
}
