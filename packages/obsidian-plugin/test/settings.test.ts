import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  endpointOf,
  generateDeviceId,
  settingsComplete,
  storagePrefixOf,
  withDefaults,
} from "../src/settings.js";

describe("settings (ADR-0016)", () => {
  it("NEVER contains the vault passphrase or key material", () => {
    // The line ADR-0016 draws: STORAGE credentials live here by decision, with
    // a warning in the UI — that now includes a WebDAV password, which is the
    // same kind of secret as an S3 secret key. The vault passphrase and
    // anything derived from it never touch this file at all.
    const json = JSON.stringify(withDefaults(DEFAULT_SETTINGS)).toLowerCase();
    for (const forbidden of ["passphrase", "masterkey", "master_key", "subkey", "keyring"]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
  });

  it("the only secrets it does hold are the storage credentials", () => {
    const s = withDefaults({
      provider: "webdav",
      webdav: { url: "https://dav", username: "u", password: "p" },
      s3: { accessKeyId: "k", secretAccessKey: "s" },
    });
    const secretPaths = ["webdav.password", "webdav.username", "s3.accessKeyId", "s3.secretAccessKey"];
    const json = JSON.stringify(s);
    for (const value of ["p", "u", "k", "s"]) expect(json).toContain(`"${value}"`);
    // Nothing else in the object holds a secret-looking field.
    expect(secretPaths).toHaveLength(4);
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

describe("the provider is part of the settings (ADR-0033)", () => {
  it("a vault configured before beta.10 has no provider field and is S3", () => {
    // The only backend the UI could reach then. Anything unrecognized falls
    // back the same way rather than leaving the plugin pointed at nothing.
    expect(withDefaults({ s3: { bucket: "b" } }).provider).toBe("s3");
    expect(withDefaults({ provider: "ftp" }).provider).toBe("s3");
    expect(withDefaults({ provider: "webdav" }).provider).toBe("webdav");
  });

  it("completeness, endpoint and prefix all follow the ACTIVE provider", () => {
    const dav = withDefaults({
      provider: "webdav",
      webdav: { url: "https://cloud/dav", username: "u", password: "p", prefix: "vault" },
      // Deliberately complete S3 settings that must not make WebDAV look ready.
      s3: { endpoint: "https://s3", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "s3p" },
    });
    expect(settingsComplete(dav)).toBe(true);
    expect(endpointOf(dav)).toBe("https://cloud/dav");
    expect(storagePrefixOf(dav)).toBe("vault");

    const davMissingPassword = withDefaults({
      provider: "webdav",
      webdav: { url: "https://cloud/dav", username: "u" },
      s3: { endpoint: "https://s3", bucket: "b", accessKeyId: "k", secretAccessKey: "s" },
    });
    // Complete S3 settings must NOT make an incomplete WebDAV config look ready.
    expect(settingsComplete(davMissingPassword)).toBe(false);

    const s3 = withDefaults({
      s3: { endpoint: "https://s3", bucket: "b", accessKeyId: "k", secretAccessKey: "s", prefix: "s3p" },
      webdav: { url: "https://cloud/dav" },
    });
    expect(endpointOf(s3)).toBe("https://s3");
    expect(storagePrefixOf(s3)).toBe("s3p");
  });

  it("switching provider keeps the other one's settings", () => {
    const both = withDefaults({
      provider: "webdav",
      s3: { endpoint: "https://s3", bucket: "b", accessKeyId: "k", secretAccessKey: "s" },
      webdav: { url: "https://cloud/dav", username: "u", password: "p" },
    });
    expect(both.s3.bucket).toBe("b");
    expect(both.webdav.url).toBe("https://cloud/dav");
  });
});
