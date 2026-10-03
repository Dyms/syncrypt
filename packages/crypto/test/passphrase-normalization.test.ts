// ADR-0057. Argon2id hashes bytes, and Unicode lets one passphrase be typed as
// more than one byte string: "café" is five code points on most keyboards and
// six after a decomposing IME, a paste out of macOS, or a Vietnamese or Korean
// input method. Nothing in the key hierarchy said which one is THE passphrase,
// so two devices whose users type the same characters derived two different
// vaults — and the second one was told its passphrase is wrong.
//
// RFC-0005 now fixes the input as UTF-8 NFC. These tests hold both halves: the
// spec form is what gets written, and a vault written before the spec existed
// can still be opened deliberately.

import { describe, expect, it } from "vitest";

import { isSyncError } from "@syncrypt/core";

import {
  createConnectionTicket,
  deriveMasterKeyBytes,
  legacyPassphraseForms,
  openConnectionTicket,
  SyncryptCrypto,
} from "../src/index.js";
import { TEST_PARAMS } from "./params.js";

/** The same passphrase, composed (NFC) and decomposed (NFD). */
const COMPOSED = "passphrase caf\u00e9"; //  é  as one code point
const DECOMPOSED = "passphrase cafe\u0301"; // e + combining acute

const hex = (b: Uint8Array): string =>
  [...b].map((n) => n.toString(16).padStart(2, "0")).join("");

describe("one passphrase, one key", () => {
  it("THE TWO SPELLINGS OF THE SAME PASSPHRASE DERIVE THE SAME KEY", async () => {
    expect(COMPOSED).not.toBe(DECOMPOSED); // different strings…
    expect(COMPOSED.normalize("NFC")).toBe(DECOMPOSED.normalize("NFC")); // …same characters

    const a = await deriveMasterKeyBytes(COMPOSED, TEST_PARAMS);
    const b = await deriveMasterKeyBytes(DECOMPOSED, TEST_PARAMS);
    expect(hex(a)).toBe(hex(b));
  });

  it("a vault written by one spelling is read by the other", async () => {
    const writer = await SyncryptCrypto.create(DECOMPOSED, TEST_PARAMS);
    const reader = await SyncryptCrypto.create(COMPOSED, TEST_PARAMS);
    const blob = await writer.encrypt("content", new TextEncoder().encode("secret"));
    expect(new TextDecoder().decode(await reader.decrypt("content", blob))).toBe("secret");
  });

  it("A DIFFERENT PASSPHRASE IS STILL A DIFFERENT KEY", async () => {
    const a = await deriveMasterKeyBytes(COMPOSED, TEST_PARAMS);
    const b = await deriveMasterKeyBytes("passphrase cafe", TEST_PARAMS); // no accent at all
    expect(hex(a)).not.toBe(hex(b));
  });

  it("a ticket written under one spelling opens under the other", async () => {
    const ticket = await createConnectionTicket(
      {
        provider: "s3",
        endpoint: "https://s3.example",
        region: "eu-north-1",
        bucket: "vault",
        forcePathStyle: false,
        prefix: "vaults/main",
      },
      DECOMPOSED,
    );
    expect((await openConnectionTicket(ticket, COMPOSED)).prefix).toBe("vaults/main");
    await expect(openConnectionTicket(ticket, "not the passphrase")).rejects.toSatisfy((e) =>
      isSyncError(e, "CryptoAuthError"),
    );
  });
});

describe("what counts as a legacy form", () => {
  it("AN ASCII PASSPHRASE HAS NONE — THE COMMON CASE DERIVES EXACTLY ONCE", () => {
    expect(legacyPassphraseForms("correct horse battery staple")).toEqual([]);
    expect(legacyPassphraseForms("")).toEqual([]);
  });

  it("text already composed differs from its decomposition only", () => {
    expect(legacyPassphraseForms(COMPOSED)).toEqual(["nfd"]);
  });

  it("text typed decomposed is its own second candidate, listed once", () => {
    // "as-typed" IS the decomposition here, so "nfd" is the same bytes and is
    // not offered twice — the fallback never derives the same key twice.
    expect(legacyPassphraseForms(DECOMPOSED)).toEqual(["as-typed"]);
  });

  it("Korean and Vietnamese text has a legacy form too", () => {
    expect(legacyPassphraseForms("비밀번호")).toEqual(["nfd"]);
    expect(legacyPassphraseForms("mật khẩu")).toEqual(["nfd"]);
  });

  it("the form actually changes the derived key", async () => {
    const spec = await deriveMasterKeyBytes(DECOMPOSED, TEST_PARAMS, "nfc");
    const legacy = await deriveMasterKeyBytes(DECOMPOSED, TEST_PARAMS, "as-typed");
    expect(hex(spec)).not.toBe(hex(legacy));
  });
});

describe("a vault created before the spec still opens", () => {
  it("THE LEGACY FORM READS IT AND THE SPEC FORM DOES NOT", async () => {
    // What a pre-ADR-0057 client on a decomposing device produced.
    const legacy = await SyncryptCrypto.create(DECOMPOSED, TEST_PARAMS, "as-typed");
    const blob = await legacy.encrypt("content", new TextEncoder().encode("older vault"));

    const spec = await SyncryptCrypto.create(DECOMPOSED, TEST_PARAMS);
    await expect(spec.decrypt("content", blob)).rejects.toSatisfy((e) =>
      isSyncError(e, "CryptoAuthError"),
    );

    const again = await SyncryptCrypto.create(DECOMPOSED, TEST_PARAMS, "as-typed");
    expect(new TextDecoder().decode(await again.decrypt("content", blob))).toBe("older vault");
  });

  it("and a device typing the composed spelling can reach it as NFD", async () => {
    // The cross-device half: the vault holds the decomposed key, the user at
    // the second device types the composed characters. "as-typed" is no help
    // there — "nfd" is, and it is in the candidate list for exactly this.
    const vault = await SyncryptCrypto.create(DECOMPOSED, TEST_PARAMS, "as-typed");
    const blob = await vault.encrypt("content", new TextEncoder().encode("older vault"));

    expect(legacyPassphraseForms(COMPOSED)).toContain("nfd");
    const second = await SyncryptCrypto.create(COMPOSED, TEST_PARAMS, "nfd");
    expect(new TextDecoder().decode(await second.decrypt("content", blob))).toBe("older vault");
  });
});
