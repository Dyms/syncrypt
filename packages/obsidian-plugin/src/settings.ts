// Plugin settings — persisted in data.json (ADR-0016: storage credentials
// live here BY DECISION, with a UI warning; the passphrase NEVER does).

import { DEFAULT_CONFIG_SYNC, type ConfigSyncSettings } from "./config-sync.js";
import type { LangSetting } from "./i18n.js";
import { DEFAULT_PROFILE, type SyncProfile } from "./profile.js";

/**
 * Floors for the Safe-Sync numbers the user can type, in the units the SETTINGS
 * screen uses (ADR-0054).
 *
 * Two of these already had a floor and one did not, which is how a vault could
 * be opted out of version retention by one device: `versionsToKeep: 0` is not a
 * per-device preference, because the manifest records how many versions a vault
 * HAS and never how many it wants. A push from a device set to zero therefore
 * cannot start a history for a vault that has none, and the version it
 * overwrites is retained nowhere.
 *
 * Kept here rather than in the settings tab so the rule is testable without
 * Obsidian's runtime.
 */
export const SAFE_SYNC_FLOORS = {
  versionsToKeep: 1,
  generationsToKeep: 1,
  /** Hours, as typed; the engine holds seconds. */
  reclaimGraceHours: 1,
} as const;

/** Apply a floor to what the user typed. Fractions and NaN floor too. */
export function flooredSetting(
  name: keyof typeof SAFE_SYNC_FLOORS,
  raw: number,
): number {
  const floor = SAFE_SYNC_FLOORS[name];
  return Number.isFinite(raw) ? Math.max(floor, Math.floor(raw)) : floor;
}

/** Apply every floor to a whole Safe-Sync block, in the units it stores. */
function flooredSafeSync<T extends SafeSyncNumbers>(safeSync: T): T {
  return {
    ...safeSync,
    versionsToKeep: flooredSetting("versionsToKeep", safeSync.versionsToKeep),
    generationsToKeep: flooredSetting("generationsToKeep", safeSync.generationsToKeep),
    reclaimGraceSeconds:
      flooredSetting("reclaimGraceHours", Math.round(safeSync.reclaimGraceSeconds / 3600)) * 3600,
  };
}

interface SafeSyncNumbers {
  versionsToKeep: number;
  generationsToKeep: number;
  reclaimGraceSeconds: number;
}

/** The backends the plugin can talk to (ADR-0033). */
type StorageProviderKind = "s3" | "webdav";

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
  /**
   * The ID has been handed to this installation's own storage (ADR-0069).
   * Set, and no ID in the installation: the folder was copied from another.
   */
  deviceIdInstalled: boolean;
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
  deviceIdInstalled: false,
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
    // S3 keeps its prefix as stored: beta.12 used "/notes" and "a//b" as typed,
    // and S3 holds such keys — normalizing on load moved the vault to an
    // empty place (post-fix review, R4; ADR-0081). The unlock says why such a
    // prefix is refused now instead. WebDAV already refused them in beta.12.
    s3: { ...DEFAULT_SETTINGS.s3, ...raw.s3 },
    // A vault configured before beta.10 has no `provider` and is S3 — the only
    // backend the UI could reach. Anything unrecognized falls back the same
    // way rather than leaving the plugin pointed at nothing.
    provider: raw.provider === "webdav" ? "webdav" : "s3",
    webdav: withPrefix({ ...DEFAULT_SETTINGS.webdav, ...raw.webdav }),
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
    // Floors applied on LOAD as well as on edit: a value stored before they
    // existed keeps its effect until someone opens that field, and a device
    // sitting at versionsToKeep 0 opts the whole vault out of retention
    // without anything on screen saying so (ADR-0054).
    safeSync: flooredSafeSync({ ...DEFAULT_SETTINGS.safeSync, ...raw.safeSync }),
    autoSync: { ...autoSyncDefaults, ...raw.autoSync },
    kdfProfile: raw.kdfProfile ?? DEFAULT_SETTINGS.kdfProfile,
    deviceId: raw.deviceId !== undefined && raw.deviceId !== "" ? raw.deviceId : generateDeviceId(),
    deviceIdInstalled: raw.deviceIdInstalled === true,
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

/**
 * WHICH vault the settings point at, as one canonical string (ADR-0065).
 *
 * Two spellings that reach the same objects should give the same string, so
 * the scheme and host are lowercased and trailing slashes dropped — the same
 * slashes the providers drop. Two that reach different objects must give
 * different strings; when in doubt this errs that way, because the only cost
 * of a false "different" is one full reconcile (conflicts, never loss), and
 * the cost of a false "same" is a base from another vault.
 *
 * Credentials and region are not part of it: they change how we reach the
 * objects, not which ones.
 */
export function storageLocationOf(s: SyncryptSettings): string {
  const trimSlashes = (v: string): string => v.trim().replace(/\/+$/, "");
  const url = (raw: string): string => {
    const v = trimSlashes(raw);
    try {
      const u = new URL(v);
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    } catch {
      return v;
    }
  };
  if (s.provider === "webdav") {
    return ["webdav", url(s.webdav.url), trimSlashes(s.webdav.prefix)].join("\n");
  }
  return ["s3", url(s.s3.endpoint), s.s3.bucket.trim(), trimSlashes(s.s3.prefix)].join("\n");
}

/**
 * A short, stable tag of `storageLocationOf` for a file name: FNV-1a, 64 bit.
 * Not a security property — it names a cache file — but 64 bits keeps two
 * locations one person uses from ever sharing a name.
 */
export function storageLocationTag(s: SyncryptSettings): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(storageLocationOf(s))) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** The location as a person reads it, for the "no vault here" question. */
export function describeStorageLocation(s: SyncryptSettings): string {
  if (s.provider === "webdav") {
    const prefix = s.webdav.prefix.trim();
    return prefix === "" ? s.webdav.url.trim() : `${s.webdav.url.trim()} → ${prefix}`;
  }
  const prefix = s.s3.prefix.trim();
  const where = `${s.s3.bucket.trim()}${prefix === "" ? "" : `/${prefix}`}`;
  return `${where} @ ${s.s3.endpoint.trim()}`;
}

/**
 * A prefix as the storage will use it (ADR-0074): no slash at either end, no
 * empty segment in between. Applied to what is TYPED, and to a WebDAV prefix
 * on load (WebDAV refused empty segments in beta.12 already). Not to an S3
 * prefix on load: there "/notes" was a working vault in beta.12 (ADR-0081).
 */
export function normalizePrefix(v: string): string {
  return v
    .trim()
    .split("/")
    .filter((segment) => segment !== "")
    .join("/");
}

function withPrefix<T extends { prefix: string }>(group: T): T {
  return { ...group, prefix: typeof group.prefix === "string" ? normalizePrefix(group.prefix) : "" };
}

/**
 * The provider data.json names when this build does not know it — a newer
 * Syncrypt wrote the file and this one is a downgrade (ADR-0075). Null when it
 * is known or absent. In memory `withDefaults` falls back to S3 (ADR-0033);
 * this is what keeps that fallback from being written back, or connected to.
 */
export function foreignProvider(loaded: unknown): string | null {
  if (typeof loaded !== "object" || loaded === null) return null;
  const p = (loaded as { provider?: unknown }).provider;
  if (p === undefined || p === "s3" || p === "webdav") return null;
  return typeof p === "string" ? p : JSON.stringify(p);
}

/**
 * Top-level keys in data.json that this build does not know, to write back
 * untouched (ADR-0075). A newer build's fields are its own; this one has no
 * business deleting them because it cannot read them.
 */
export function unknownKeys(loaded: unknown): Record<string, unknown> {
  if (typeof loaded !== "object" || loaded === null) return {};
  const known = new Set(Object.keys(DEFAULT_SETTINGS));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(loaded)) if (!known.has(k)) out[k] = v;
  return out;
}
