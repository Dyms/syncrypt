// What a comparison loads, and from where (RFC-0010).

import { describe, expect, it } from "vitest";

import type { FileVersions, Operation } from "@syncrypt/core";

import {
  loadComparison,
  requestForOperation,
  restoredCopyPath,
  VersionGoneError,
  type CompareDeps,
} from "../src/compare-loader.js";
import { MAX_DIFF_BYTES } from "../src/text-diff.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function op(kind: Operation["kind"], extra: Partial<Operation> = {}): Operation {
  return { kind, path: "n.md", reason: "x" as never, ...extra };
}

describe("requestForOperation", () => {
  it("an overwrite compares the local file with the stored one that would replace it", () => {
    expect(requestForOperation(op("download", { localHash: "L", remoteHash: "R" }))).toEqual({
      path: "n.md",
      left: { kind: "local" },
      right: { kind: "stored", hash: "R" },
    });
  });
  it("a download that creates a file has nothing to compare", () => {
    expect(requestForOperation(op("download", { remoteHash: "R" }))).toBeNull();
  });
  it("a deletion here shows the local file against nothing", () => {
    expect(requestForOperation(op("delete-local", { localHash: "L" }))).toEqual({
      path: "n.md",
      left: { kind: "local" },
      right: { kind: "absent" },
    });
  });
  it("a deletion in storage shows the stored version against nothing", () => {
    expect(requestForOperation(op("delete-remote", { remoteHash: "R" }))).toEqual({
      path: "n.md",
      left: { kind: "stored", hash: "R" },
      right: { kind: "absent" },
    });
    expect(requestForOperation(op("delete-remote"))).toBeNull();
  });
  it("uploads and no-ops have nothing to compare", () => {
    expect(requestForOperation(op("upload", { localHash: "L" }))).toBeNull();
    expect(requestForOperation(op("noop"))).toBeNull();
  });
});

function deps(files: {
  local?: string | null;
  stored?: Record<string, string>;
  localSize?: number;
  storedSize?: Record<string, number>;
}): CompareDeps & { reads: string[] } {
  const reads: string[] = [];
  const stored = files.stored ?? {};
  return {
    reads,
    localStat: (): Promise<{ size: number; mtime: number } | null> =>
      Promise.resolve(
        files.local === null || files.local === undefined
          ? null
          : { size: files.localSize ?? files.local.length, mtime: 1_700_000_000 },
      ),
    readLocal: (): Promise<Uint8Array> => {
      reads.push("local");
      return Promise.resolve(enc(files.local ?? ""));
    },
    listVersions: (): Promise<FileVersions> =>
      Promise.resolve({
        deleted: false,
        versions: Object.entries(stored).map(([hash, body], i) => ({
          hash,
          size: files.storedSize?.[hash] ?? body.length,
          mtime: 1_690_000_000 + i,
          current: i === 0,
        })),
      }),
    readStored: (_p, hash): Promise<Uint8Array> => {
      reads.push(`stored:${hash}`);
      return Promise.resolve(enc(stored[hash] ?? ""));
    },
  };
}

describe("loadComparison", () => {
  const req = {
    path: "n.md",
    left: { kind: "local" as const },
    right: { kind: "stored" as const, hash: "R" },
  };

  it("diffs the local file against a stored version and reports both sides", async () => {
    const c = await loadComparison(req, deps({ local: "a\nb\n", stored: { R: "a\nc\n" } }));
    expect(c.result.kind).toBe("hunks");
    expect(c.left.size).toBe(4);
    expect(c.right.size).toBe(4);
    expect(c.right.mtime).toBe(1_690_000_000);
  });

  it("a missing local file is an absent side, not an error", async () => {
    const c = await loadComparison(req, deps({ local: null, stored: { R: "x\n" } }));
    expect(c.left.side).toEqual({ kind: "absent" });
    expect(c.result.kind).toBe("hunks");
  });

  it("a stored version that is gone is said, not guessed", async () => {
    await expect(loadComparison(req, deps({ local: "a", stored: {} }))).rejects.toBeInstanceOf(
      VersionGoneError,
    );
  });

  it("SAFETY: a large file is never downloaded just to say it is too large", async () => {
    const d = deps({ local: "a", stored: { R: "x" }, storedSize: { R: MAX_DIFF_BYTES + 1 } });
    const c = await loadComparison(req, d);
    expect(c.result).toEqual({ kind: "too-large", reason: "bytes" });
    expect(d.reads).toEqual([]);
  });

  it("a large local file is not read either", async () => {
    const d = deps({ local: "a", localSize: MAX_DIFF_BYTES + 1, stored: { R: "x" } });
    await loadComparison(req, d);
    expect(d.reads).toEqual([]);
  });

  it("two stored versions can be compared with each other", async () => {
    const c = await loadComparison(
      { path: "n.md", left: { kind: "stored", hash: "OLD" }, right: { kind: "stored", hash: "NEW" } },
      deps({ stored: { NEW: "new\n", OLD: "old\n" } }),
    );
    expect(c.result.kind).toBe("hunks");
  });

  it("reads nothing for an absent side", async () => {
    const d = deps({ stored: { R: "x\n" } });
    await loadComparison(
      { path: "n.md", left: { kind: "stored", hash: "R" }, right: { kind: "absent" } },
      d,
    );
    expect(d.reads).toEqual(["stored:R"]);
  });
});

describe("restoredCopyPath", () => {
  const none = (): Promise<boolean> => Promise.resolve(false);
  const at = 1_760_000_000; // 2025-10-09

  it("names the copy for the version's own date, next to the file", async () => {
    expect(await restoredCopyPath("notes/idea.md", at, none)).toBe(
      "notes/idea (restored from 2025-10-09).md",
    );
    expect(await restoredCopyPath("idea.md", at, none)).toBe("idea (restored from 2025-10-09).md");
  });

  it("never lands on an existing file", async () => {
    const taken = new Set([
      "idea (restored from 2025-10-09).md",
      "idea (restored from 2025-10-09 2).md",
    ]);
    expect(await restoredCopyPath("idea.md", at, (p) => Promise.resolve(taken.has(p)))).toBe(
      "idea (restored from 2025-10-09 3).md",
    );
  });

  it("handles files with no extension and dotfiles", async () => {
    expect(await restoredCopyPath("LICENSE", at, none)).toBe("LICENSE (restored from 2025-10-09)");
    expect(await restoredCopyPath("a/.hidden", at, none)).toBe("a/.hidden (restored from 2025-10-09)");
    expect(await restoredCopyPath("a.b/c.tar.gz", at, none)).toBe(
      "a.b/c.tar (restored from 2025-10-09).gz",
    );
  });
});
