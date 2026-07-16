// Golden fixtures — one per RFC-0004 decision-table row, plus the amended
// edit-vs-delete rows, tombstone-in-base combinations, case collisions
// (ADR-0007), the Safe-Sync circuit breaker (ADR-0010) and the divergence guard.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLAN_OPTIONS,
  plan,
  ReasonCode,
  type Manifest,
  type Operation,
  type SyncPlan,
} from "../src/index.js";
import { localFiles, manifest } from "./helpers.js";

const P = "note.md";

/** Run plan() for a single path in states (local, base, remote); "†" = tombstone. */
function planOne(
  local: string | null,
  base: string | null,
  remote: string | null,
  baseGen = 1,
  remoteGen = 1,
): SyncPlan {
  const baseM: Manifest | null =
    base === null && remote === null
      ? null
      : manifest({
          generation: baseGen,
          files: base !== null && base !== "†" ? { [P]: base } : {},
          tombstones: base === "†" ? [P] : [],
        });
  const remoteM: Manifest | null =
    remote === null && base === null
      ? null
      : manifest({
          generation: remoteGen,
          files: remote !== null && remote !== "†" ? { [P]: remote } : {},
          tombstones: remote === "†" ? [P] : [],
        });
  return plan(
    localFiles(local !== null ? { [P]: local } : {}),
    baseM,
    remoteM,
    DEFAULT_PLAN_OPTIONS,
  );
}

function only(p: SyncPlan): Operation {
  expect(p.operations).toHaveLength(1);
  const op = p.operations[0];
  if (op === undefined) throw new Error("unreachable");
  return op;
}

describe("RFC-0004 decision table", () => {
  it("A A A → none (unchanged everywhere)", () => {
    expect(planOne("b3:a", "b3:a", "b3:a").operations).toEqual([]);
  });

  it("B A A → upload (changed only locally)", () => {
    const op = only(planOne("b3:b", "b3:a", "b3:a"));
    expect(op.kind).toBe("upload");
    expect(op.reason).toBe(ReasonCode.LocalChanged);
  });

  it("A A B → download (changed only remotely)", () => {
    const op = only(planOne("b3:a", "b3:a", "b3:b"));
    expect(op.kind).toBe("download");
    expect(op.reason).toBe(ReasonCode.RemoteNewer);
  });

  it("B A B → none (same change both sides)", () => {
    expect(planOne("b3:b", "b3:a", "b3:b").operations).toEqual([]);
  });

  it("B A C → conflict (changed differently both sides)", () => {
    const op = only(planOne("b3:b", "b3:a", "b3:c"));
    expect(op.kind).toBe("conflict");
    expect(op.reason).toBe(ReasonCode.ConflictBothChanged);
    expect(op.localHash).toBe("b3:b");
    expect(op.baseHash).toBe("b3:a");
    expect(op.remoteHash).toBe("b3:c");
  });

  it("⌀ A A → delete-remote (deleted locally)", () => {
    const op = only(planOne(null, "b3:a", "b3:a"));
    expect(op.kind).toBe("delete-remote");
    expect(op.reason).toBe(ReasonCode.DeletedLocally);
  });

  it("A A † → delete-local (deleted remotely)", () => {
    const op = only(planOne("b3:a", "b3:a", "†"));
    expect(op.kind).toBe("delete-local");
    expect(op.reason).toBe(ReasonCode.DeletedRemotely);
  });

  it("B ⌀ ⌀ → upload (new local file)", () => {
    const op = only(planOne("b3:b", null, null));
    expect(op.kind).toBe("upload");
    expect(op.reason).toBe(ReasonCode.NewLocalFile);
  });

  it("⌀ ⌀ B → download (new remote file)", () => {
    const op = only(planOne(null, null, "b3:b"));
    expect(op.kind).toBe("download");
    expect(op.reason).toBe(ReasonCode.NewRemoteFile);
  });

  it("B ⌀ C → conflict (independently created same path)", () => {
    const op = only(planOne("b3:b", null, "b3:c"));
    expect(op.kind).toBe("conflict");
    expect(op.reason).toBe(ReasonCode.ConflictSamePath);
  });

  it("⌀ A † → none (deleted both sides)", () => {
    expect(planOne(null, "b3:a", "†").operations).toEqual([]);
  });

  it("B A † → conflict (edited locally, deleted remotely)", () => {
    const op = only(planOne("b3:b", "b3:a", "†"));
    expect(op.kind).toBe("conflict");
    expect(op.reason).toBe(ReasonCode.ConflictEditDelete);
  });

  it("⌀ A B → conflict (deleted locally, edited remotely)", () => {
    const op = only(planOne(null, "b3:a", "b3:b"));
    expect(op.kind).toBe("conflict");
    expect(op.reason).toBe(ReasonCode.ConflictEditDelete);
  });
});

describe("tombstone-in-base combinations", () => {
  it("B † † → upload (recreated after a known deletion)", () => {
    const op = only(planOne("b3:b", "†", "†"));
    expect(op.kind).toBe("upload");
    expect(op.reason).toBe(ReasonCode.NewLocalFile);
  });

  it("⌀ † B → download (recreated remotely)", () => {
    const op = only(planOne(null, "†", "b3:b"));
    expect(op.kind).toBe("download");
    expect(op.reason).toBe(ReasonCode.NewRemoteFile);
  });

  it("B † C → conflict (both recreated independently)", () => {
    const op = only(planOne("b3:b", "†", "b3:c"));
    expect(op.kind).toBe("conflict");
    expect(op.reason).toBe(ReasonCode.ConflictSamePath);
  });

  it("B ⌀ † → conflict (never-synced local file vs remote deletion)", () => {
    const op = only(planOne("b3:b", null, "†", 1, 2));
    expect(op.kind).toBe("conflict");
    expect(op.reason).toBe(ReasonCode.ConflictEditDelete);
  });

  it("⌀ ⌀ † → none (tombstone for a file we never had)", () => {
    expect(planOne(null, null, "†", 1, 2).operations).toEqual([]);
  });

  it("⌀ † † and B † (remote ⌀) behave as absence", () => {
    expect(planOne(null, "†", "†").operations).toEqual([]);
    const op = only(planOne("b3:b", "†", null));
    expect(op.kind).toBe("upload");
    expect(op.reason).toBe(ReasonCode.NewLocalFile);
  });
});

describe("case-only collisions (ADR-0007)", () => {
  it("a remote path colliding with a different local path by case → conflict", () => {
    const local = localFiles({ "note.md": "b3:a" });
    const base = manifest({ generation: 1, files: { "note.md": "b3:a" } });
    const remote = manifest({
      generation: 2,
      files: { "note.md": "b3:a", "Note.md": "b3:x" },
    });
    const p = plan(local, base, remote, DEFAULT_PLAN_OPTIONS);
    const op = only(p);
    expect(op.path).toBe("Note.md");
    expect(op.kind).toBe("conflict");
    expect(op.reason).toBe(ReasonCode.ConflictSamePath);
  });
});

describe("Safe-Sync circuit breaker (ADR-0010)", () => {
  function vault(n: number, prefix = "f"): Record<string, string> {
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) files[`${prefix}${String(i)}.md`] = `b3:${String(i)}`;
    return files;
  }

  it("mass remote deletion above threshold requires confirmation", () => {
    const files = vault(100);
    const kept = Object.fromEntries(Object.entries(files).slice(25));
    const p = plan(
      localFiles(files),
      manifest({ generation: 1, files }),
      manifest({ generation: 2, files: kept, tombstones: Object.keys(files).slice(0, 25) }),
      DEFAULT_PLAN_OPTIONS,
    );
    expect(p.summary.deletions).toBe(25);
    expect(p.requiresConfirmation).toBe(true);
    expect(p.confirmationReason).toContain("25");
  });

  it("a small deletion below threshold does not", () => {
    const files = vault(100);
    const kept = Object.fromEntries(Object.entries(files).slice(3));
    const p = plan(
      localFiles(files),
      manifest({ generation: 1, files }),
      manifest({ generation: 2, files: kept, tombstones: Object.keys(files).slice(0, 3) }),
      DEFAULT_PLAN_OPTIONS,
    );
    expect(p.requiresConfirmation).toBe(false);
  });

  it("a local wipe (scan came back empty) always requires confirmation", () => {
    const files = vault(5);
    const p = plan(
      [],
      manifest({ generation: 1, files }),
      manifest({ generation: 1, files }),
      DEFAULT_PLAN_OPTIONS,
    );
    expect(p.summary.deletions).toBe(5);
    expect(p.requiresConfirmation).toBe(true);
  });

  it("new-file downloads are not destructive (initial sync needs no confirmation)", () => {
    const files = vault(100);
    const p = plan([], null, manifest({ generation: 3, files }), DEFAULT_PLAN_OPTIONS);
    expect(p.summary.downloads).toBe(100);
    expect(p.requiresConfirmation).toBe(false);
  });
});

describe("divergence guard (pullFirst)", () => {
  it("remote generation ahead of base → pullFirst", () => {
    expect(planOne("b3:a", "b3:a", "b3:a", 1, 2).pullFirst).toBe(true);
    expect(planOne("b3:a", "b3:a", "b3:a", 2, 2).pullFirst).toBe(false);
  });

  it("fresh device with existing remote → pullFirst; empty remote → not", () => {
    const remote = manifest({ generation: 3, files: { [P]: "b3:a" } });
    expect(plan([], null, remote, DEFAULT_PLAN_OPTIONS).pullFirst).toBe(true);
    expect(plan(localFiles({ [P]: "b3:a" }), null, null, DEFAULT_PLAN_OPTIONS).pullFirst).toBe(false);
  });
});

describe("plan shape", () => {
  it("orders deterministically by kind then path, and counts the summary", () => {
    const local = localFiles({
      "up-new.md": "b3:n",
      "up-mod.md": "b3:m2",
      "keep.md": "b3:k",
      "confl.md": "b3:c1",
      "old.md": "b3:o",
      "down.md": "b3:d1",
    });
    const base = manifest({
      generation: 1,
      files: {
        "up-mod.md": "b3:m1",
        "keep.md": "b3:k",
        "confl.md": "b3:c0",
        "old.md": "b3:o",
        "gone-local.md": "b3:g",
        "down.md": "b3:d1",
      },
    });
    const remote = manifest({
      generation: 2,
      files: {
        "up-mod.md": "b3:m1",
        "keep.md": "b3:k",
        "confl.md": "b3:c2",
        "gone-local.md": "b3:g",
        "down.md": "b3:d2",
        "new-remote.md": "b3:r",
      },
      tombstones: ["old.md"],
    });
    const p = plan(local, base, remote, DEFAULT_PLAN_OPTIONS);
    expect(p.operations.map((o) => [o.kind, o.path])).toEqual([
      ["conflict", "confl.md"],
      ["download", "down.md"],
      ["download", "new-remote.md"],
      ["delete-local", "old.md"],
      ["upload", "up-mod.md"],
      ["upload", "up-new.md"],
      ["delete-remote", "gone-local.md"],
    ]);
    expect(p.summary).toEqual({ uploads: 2, downloads: 2, deletions: 2, conflicts: 1 });
    // 3 destructive ops (replace-download, delete-local, delete-remote) in a
    // 6-file vault trips the ADR-0010 breaker: 3 > min(20, 0.6).
    expect(p.requiresConfirmation).toBe(true);
  });
});
