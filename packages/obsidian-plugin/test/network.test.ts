import { describe, expect, it } from "vitest";

import { autoSyncAllowed } from "../src/network.js";
import { withDefaults } from "../src/settings.js";

describe("auto-sync network policy (RFC-0004)", () => {
  it("wifiOnly blocks cellular, allows wifi/unknown, and offline blocks everything", () => {
    expect(autoSyncAllowed(true, { onLine: true, type: "cellular" })).toBe(false);
    expect(autoSyncAllowed(true, { onLine: true, type: "wifi" })).toBe(true);
    expect(autoSyncAllowed(true, { onLine: true })).toBe(true); // unknown type
    expect(autoSyncAllowed(true, null)).toBe(true); // no platform info
    expect(autoSyncAllowed(true, { onLine: false })).toBe(false);
    expect(autoSyncAllowed(false, { onLine: true, type: "cellular" })).toBe(true);
    expect(autoSyncAllowed(false, { onLine: false })).toBe(false);
  });
});

describe("platform defaults (compatibility matrix)", () => {
  it("mobile gets wifi-only ON and a 120 s minimum interval by default", () => {
    const mobile = withDefaults(null, { mobile: true });
    expect(mobile.autoSync.wifiOnly).toBe(true);
    expect(mobile.autoSync.minIntervalSec).toBe(120);
    expect(mobile.autoSync.debounceSec).toBe(15);

    const desktop = withDefaults(null, { mobile: false });
    expect(desktop.autoSync.wifiOnly).toBe(false);
    expect(desktop.autoSync.minIntervalSec).toBe(30);
  });

  it("explicit user choices survive the platform defaults", () => {
    const saved = { autoSync: { enabled: true, debounceSec: 5, minIntervalSec: 60, wifiOnly: false } };
    const merged = withDefaults(saved, { mobile: true });
    expect(merged.autoSync.wifiOnly).toBe(false); // user turned it off — respected
    expect(merged.autoSync.minIntervalSec).toBe(60);
  });

  it("kdfProfile defaults to cross-device (ADR-0018)", () => {
    expect(withDefaults(null).kdfProfile).toBe("cross-device");
    expect(withDefaults({ kdfProfile: "desktop-only" }).kdfProfile).toBe("desktop-only");
  });
});
