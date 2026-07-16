import { describe, expect, it } from "vitest";

import {
  canonicalizePath,
  detectCaseCollisions,
  isCanonicalPath,
  SyncError,
} from "../src/index.js";

describe("canonicalizePath (ADR-0007)", () => {
  it("normalizes NFD to NFC", () => {
    const nfd = "resumé.md"; // e + combining acute
    const nfc = "resumé.md";
    expect(canonicalizePath(nfd)).toBe(nfc);
    expect(canonicalizePath(nfc)).toBe(nfc);
  });

  it("converts backslashes and strips redundant segments", () => {
    expect(canonicalizePath("dir\\sub\\note.md")).toBe("dir/sub/note.md");
    expect(canonicalizePath("./dir//note.md")).toBe("dir/note.md");
    expect(canonicalizePath("dir/note.md/")).toBe("dir/note.md");
  });

  it("rejects empty and escaping paths", () => {
    expect(() => canonicalizePath("")).toThrow(SyncError);
    expect(() => canonicalizePath(".")).toThrow(SyncError);
    expect(() => canonicalizePath("../evil.md")).toThrow(SyncError);
    expect(() => canonicalizePath("dir/../../evil.md")).toThrow(SyncError);
  });

  it("isCanonicalPath agrees with canonicalizePath", () => {
    expect(isCanonicalPath("dir/note.md")).toBe(true);
    expect(isCanonicalPath("dir\\note.md")).toBe(false);
    expect(isCanonicalPath("resumé.md")).toBe(false);
    expect(isCanonicalPath("")).toBe(false);
  });
});

describe("detectCaseCollisions", () => {
  it("groups case-only collisions and ignores distinct paths", () => {
    expect(
      detectCaseCollisions(["Note.md", "note.md", "other.md", "NOTE.md"]),
    ).toEqual([["NOTE.md", "Note.md", "note.md"]]);
    expect(detectCaseCollisions(["a.md", "b.md"])).toEqual([]);
  });
});
