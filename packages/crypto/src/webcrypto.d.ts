// The ONLY platform globals @syncrypt/crypto relies on, beyond core's set:
// WebCrypto (globalThis.crypto) — standard in browsers, Node >= 20, and mobile
// webviews. Declared minimally (no lib.dom) so the compiler stops us from
// reaching for anything platform-specific.

interface CryptoKey {
  readonly __cryptoKeyBrand?: never;
}

interface AesGcmParams {
  name: "AES-GCM";
  iv: Uint8Array;
  additionalData?: Uint8Array;
  tagLength?: number;
}

interface HkdfParams {
  name: "HKDF";
  hash: "SHA-256";
  salt: Uint8Array;
  info: Uint8Array;
}

interface SubtleCrypto {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: "HKDF" | { name: "AES-GCM" },
    extractable: boolean,
    keyUsages: readonly ("encrypt" | "decrypt" | "deriveBits")[],
  ): Promise<CryptoKey>;
  deriveBits(algorithm: HkdfParams, baseKey: CryptoKey, length: number): Promise<ArrayBuffer>;
  encrypt(algorithm: AesGcmParams, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: AesGcmParams, key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
}

declare const crypto: {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends Uint8Array>(array: T): T;
};

// TextEncoder/TextDecoder/AbortSignal come from @syncrypt/core's globals.d.ts
// (included via tsconfig).

/** atob/btoa exist in browsers and Node >= 16 — used for base64 salt encoding. */
declare function atob(data: string): string;
declare function btoa(data: string): string;
