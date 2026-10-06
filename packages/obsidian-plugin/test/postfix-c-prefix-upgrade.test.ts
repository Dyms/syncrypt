// POST-FIX REVIEW (slice C): ADR-0074 normalizes the prefix ON LOAD, on the
// grounds that "such a prefix never worked, so no vault moves". For S3 that is
// false against the released build: 1.0.0-beta.12's S3 client had no key
// segment check (isUsableObjectKey arrived in a801a46, after the tag) and the
// engine only strips TRAILING slashes, so a beta.12 vault at "/notes" or
// "notes//2026" lives under keys "/notes/…" / "notes//2026/…" on AWS S3 (keys
// may begin with "/" or contain "//"). Loaded by this build, it points at
// "notes/…" — an empty place: VaultAbsent, the "create a vault here?" question,
// and the setting can never again say "/notes" (normalized on input as well).
import { describe, expect, it } from "vitest";

import { storagePrefixOf, withDefaults } from "../src/settings.js";

/** How the engine turns a prefix into object keys — beta.12 and HEAD alike. */
const keyFor = (prefix: string, rel: string): string => {
  const p = prefix.replace(/\/+$/, "");
  return p === "" ? rel : `${p}/${rel}`;
};

describe("an S3 vault configured on 1.0.0-beta.12 does not move on upgrade", () => {
  for (const typed of ["/notes", "notes//2026", "/notes/"]) {
    it(`prefix ${JSON.stringify(typed)}`, () => {
      // What beta.12 stored (the field trimmed whitespace only) and used.
      const beta12Key = keyFor(typed.trim(), "keyfile.json");
      const loaded = withDefaults({
        provider: "s3",
        s3: { endpoint: "https://s3.amazonaws.com", bucket: "b", prefix: typed },
        deviceId: "dev",
      });
      expect(keyFor(storagePrefixOf(loaded), "keyfile.json")).toBe(beta12Key);
    });
  }
});
