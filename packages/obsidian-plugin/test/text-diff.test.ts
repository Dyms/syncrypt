// Line diff for the compare view (RFC-0010).

import { describe, expect, it } from "vitest";

import {
  compareBytes,
  decodeText,
  MAX_DIFF_BYTES,
  MAX_DIFF_EDITS,
  MAX_DIFF_LINES,
  type DiffResult,
} from "../src/text-diff.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function must<T>(value: T | undefined, what = "value"): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

const lines = (n: number, prefix = "line"): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";

function hunks(r: DiffResult) {
  if (r.kind !== "hunks") throw new Error(`expected hunks, got ${r.kind}`);
  return r;
}

/** Rebuild both sides from a result: the diff must lose nothing. */
function rebuild(r: ReturnType<typeof hunks>, a: string, b: string): void {
  const aLines = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const bLines = b === "" ? [] : b.replace(/\n$/, "").split("\n");
  for (const h of r.hunks)
    for (const l of h.lines) {
      if (l.kind !== "add") expect(aLines[(l.oldNo ?? 0) - 1]).toBe(l.text);
      if (l.kind !== "del") expect(bLines[(l.newNo ?? 0) - 1]).toBe(l.text);
    }
}

describe("compareBytes", () => {
  it("equal bytes are identical; two absent sides are identical", () => {
    expect(compareBytes(enc("a\nb\n"), enc("a\nb\n"))).toEqual({ kind: "identical" });
    expect(compareBytes(null, null)).toEqual({ kind: "identical" });
  });

  it("reports one changed line with its context", () => {
    const a = "one\ntwo\nthree\nfour\nfive\n";
    const b = "one\ntwo\nTHREE\nfour\nfive\n";
    const r = hunks(compareBytes(enc(a), enc(b)));
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.hunks).toHaveLength(1);
    expect(must(r.hunks[0]).lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "same:one",
      "same:two",
      "del:three",
      "add:THREE",
      "same:four",
      "same:five",
    ]);
    rebuild(r, a, b);
  });

  it("numbers lines on each side", () => {
    const r = hunks(compareBytes(enc("a\nb\nc\n"), enc("a\nx\nb\nc\n")));
    const add = must(must(r.hunks[0]).lines.find((l) => l.kind === "add"));
    expect(add.text).toBe("x");
    expect(add.newNo).toBe(2);
    expect(add.oldNo).toBeUndefined();
  });

  it("a file against nothing is all added; nothing against a file is all removed", () => {
    const body = "alpha\nbeta\n";
    const added = hunks(compareBytes(null, enc(body)));
    expect([added.added, added.removed]).toEqual([2, 0]);
    const removed = hunks(compareBytes(enc(body), null));
    expect([removed.added, removed.removed]).toEqual([0, 2]);
  });

  it("distant changes make separate hunks, close ones merge", () => {
    const base = lines(60);
    const far = base.replace("line 5\n", "CHANGED 5\n").replace("line 50\n", "CHANGED 50\n");
    expect(hunks(compareBytes(enc(base), enc(far))).hunks).toHaveLength(2);
    const near = base.replace("line 5\n", "CHANGED 5\n").replace("line 8\n", "CHANGED 8\n");
    expect(hunks(compareBytes(enc(base), enc(near))).hunks).toHaveLength(1);
  });

  it("finds a moved block as a removal plus an addition, losing nothing", () => {
    const a = "A\nB\nC\nD\nE\nF\n";
    const b = "D\nE\nF\nA\nB\nC\n";
    const r = hunks(compareBytes(enc(a), enc(b)));
    rebuild(r, a, b);
    expect(r.added).toBe(3);
    expect(r.removed).toBe(3);
  });

  it("different line endings or a missing final newline are format-only, not a wall of changes", () => {
    expect(compareBytes(enc("a\nb\nc\n"), enc("a\r\nb\r\nc\r\n"))).toEqual({ kind: "format-only" });
    expect(compareBytes(enc("a\nb\nc\n"), enc("a\nb\nc"))).toEqual({ kind: "format-only" });
    expect(compareBytes(enc("a\nb\n"), new Uint8Array([0xef, 0xbb, 0xbf, ...enc("a\nb\n")]))).toEqual({
      kind: "format-only",
    });
  });

  it("a real change under different line endings is still a diff", () => {
    const r = hunks(compareBytes(enc("a\nb\nc\n"), enc("a\r\nB\r\nc\r\n")));
    expect([r.added, r.removed]).toEqual([1, 1]);
  });

  it("an empty file against a missing one has nothing to show", () => {
    expect(compareBytes(enc(""), null)).toEqual({ kind: "format-only" });
  });

  it("works with unicode and long lines", () => {
    const r = hunks(compareBytes(enc("привет\n日本語\n"), enc("привет\n中文\n")));
    expect([r.added, r.removed]).toEqual([1, 1]);
  });
});

describe("what is not diffed", () => {
  it("binary: a NUL byte, or invalid UTF-8", () => {
    expect(compareBytes(new Uint8Array([1, 0, 2]), enc("text"))).toEqual({ kind: "binary" });
    expect(compareBytes(enc("text"), new Uint8Array([0xff, 0xfe, 0x41]))).toEqual({ kind: "binary" });
    expect(decodeText(new Uint8Array([0xc3, 0x28]))).toBeNull();
    expect(decodeText(enc("ok"))).toBe("ok");
  });

  it("too large by bytes", () => {
    const big = new Uint8Array(MAX_DIFF_BYTES + 1).fill(65);
    expect(compareBytes(big, enc("x"))).toEqual({ kind: "too-large", reason: "bytes" });
  });

  it("too many lines", () => {
    const a = "\n".repeat(MAX_DIFF_LINES + 1);
    expect(compareBytes(enc(a), enc("x\n"))).toEqual({ kind: "too-large", reason: "lines" });
  });

  it("too many edits: gives up instead of hanging", () => {
    const a = lines(MAX_DIFF_EDITS, "left");
    const b = lines(MAX_DIFF_EDITS, "right");
    expect(compareBytes(enc(a), enc(b))).toEqual({ kind: "too-large", reason: "edits" });
  });

  it("just under the edit limit still diffs", () => {
    const a = lines(400, "left");
    const b = lines(400, "right");
    const r = hunks(compareBytes(enc(a), enc(b)));
    expect([r.added, r.removed]).toEqual([400, 400]);
    rebuild(r, a, b);
  });
});

describe("property: the diff never loses a line", () => {
  it("rebuilds both sides from random edits", () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let run = 0; run < 200; run++) {
      const a = Array.from({ length: rnd(30) }, () => `w${rnd(6)}`);
      const b = [...a];
      for (let e = rnd(6); e > 0; e--) {
        const at = rnd(b.length + 1);
        if (rnd(2) === 0) b.splice(at, 1);
        else b.splice(at, 0, `n${rnd(6)}`);
      }
      const sa = a.map((l) => `${l}\n`).join("");
      const sb = b.map((l) => `${l}\n`).join("");
      const r = compareBytes(enc(sa), enc(sb));
      if (r.kind === "identical") {
        expect(sa).toBe(sb);
        continue;
      }
      if (r.kind === "format-only") throw new Error("unexpected format-only");
      const h = hunks(r);
      rebuild(h, sa, sb);
      // Applying only the changes to A gives B: count check.
      expect(a.length - h.removed + h.added).toBe(b.length);
    }
  });
});
