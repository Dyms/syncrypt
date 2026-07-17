// Plugin settings — persisted in data.json (ADR-0016: S3 credentials live
// here BY DECISION, with a UI warning; the passphrase NEVER does).

import { DEFAULT_PROFILE, type SyncProfile } from "./profile.js";

export interface SyncryptSettings {
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
  };
  /** Stable random per-device UUID (RFC-0007), generated on first run. */
  deviceId: string;
}

export const DEFAULT_SETTINGS: SyncryptSettings = {
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
  },
  deviceId: "",
};

export function withDefaults(loaded: unknown): SyncryptSettings {
  const raw = (typeof loaded === "object" && loaded !== null ? loaded : {}) as Partial<SyncryptSettings>;
  return {
    s3: { ...DEFAULT_SETTINGS.s3, ...raw.s3 },
    profile: {
      include: raw.profile?.include ?? DEFAULT_SETTINGS.profile.include,
      exclude: raw.profile?.exclude ?? DEFAULT_SETTINGS.profile.exclude,
    },
    safeSync: { ...DEFAULT_SETTINGS.safeSync, ...raw.safeSync },
    autoSync: { ...DEFAULT_SETTINGS.autoSync, ...raw.autoSync },
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
