import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, generateDeviceId, settingsComplete, withDefaults } from "../src/settings.js";

describe("settings (ADR-0016)", () => {
  it("NEVER contains a passphrase or key material field", () => {
    const json = JSON.stringify(withDefaults(DEFAULT_SETTINGS)).toLowerCase();
    expect(json).not.toContain("passphrase");
    expect(json).not.toContain("masterkey");
    expect(json).not.toContain("password");
  });

  it("merges partial persisted data over defaults and generates a deviceId once", () => {
    const merged = withDefaults({ s3: { bucket: "b" }, deviceId: "dev-existing" });
    expect(merged.s3.bucket).toBe("b");
    expect(merged.s3.forcePathStyle).toBe(true);
    expect(merged.safeSync.bulkChangeFloor).toBe(5); // ADR-0013 default
    expect(merged.deviceId).toBe("dev-existing");

    const fresh = withDefaults(null);
    expect(fresh.deviceId).toMatch(/^dev-[0-9a-f]{16}$/);
    expect(generateDeviceId()).not.toBe(generateDeviceId());
  });

  it("settingsComplete requires endpoint, bucket, and credentials", () => {
    expect(settingsComplete(withDefaults(null))).toBe(false);
    const full = withDefaults({
      s3: { endpoint: "http://x", bucket: "b", accessKeyId: "k", secretAccessKey: "s" },
    });
    expect(settingsComplete(full)).toBe(true);
  });
});
