// The ONLY platform globals @syncrypt/core relies on. All are WHATWG-standard
// and exist in browsers, Node >= 20, and mobile JS engines — none are Node-only
// (RFC-0003 §Portability). Declared minimally instead of pulling lib.dom so the
// compiler stops us from reaching for anything else.

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
}

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}
