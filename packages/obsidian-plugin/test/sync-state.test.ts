// The honesty rule, unit-tested: "synced ✓" appears only when it is TRUE.

import { describe, expect, it } from "vitest";

import { classifyCounts, deriveSyncState, type SyncStateInput } from "../src/sync-state.js";

const base: SyncStateInput = {
  locked: false,
  syncing: false,
  appliedSoFar: 0,
  onLine: true,
  status: { baseGeneration: 7, dirtyFiles: 0 },
  lastOutcome: "applied",
  lastSyncAt: Date.parse("2026-07-18T10:00:00Z"),
  lastError: null,
  conflicts: 0,
  counts: { notes: 120, attachments: 14 },
};

describe("deriveSyncState", () => {
  it("synced ✓ only in the fully-clean case", () => {
    expect(deriveSyncState(base).kind).toBe("synced");
    expect(deriveSyncState({ ...base, lastOutcome: "no-op" }).kind).toBe("synced");
  });

  it("HONESTY: dirty files, unclean outcomes, or missing facts are never green", () => {
    expect(deriveSyncState({ ...base, status: { baseGeneration: 7, dirtyFiles: 3 } }).kind).toBe("pending");
    expect(deriveSyncState({ ...base, lastOutcome: "pull-first" }).kind).toBe("pending");
    expect(deriveSyncState({ ...base, lastOutcome: "needs-confirmation" }).kind).toBe("pending");
    expect(deriveSyncState({ ...base, lastOutcome: "aborted" }).kind).toBe("pending");
    expect(deriveSyncState({ ...base, lastOutcome: null }).kind).toBe("pending");
    expect(deriveSyncState({ ...base, status: null }).kind).toBe("pending");
    expect(deriveSyncState({ ...base, status: { baseGeneration: null, dirtyFiles: 0 } }).kind).toBe("pending");
  });

  it("state priorities: locked > syncing > offline > error > conflict", () => {
    expect(deriveSyncState({ ...base, locked: true, syncing: true }).kind).toBe("locked");
    expect(deriveSyncState({ ...base, syncing: true, onLine: false }).kind).toBe("syncing");
    expect(deriveSyncState({ ...base, onLine: false, conflicts: 2 }).kind).toBe("offline");
    expect(deriveSyncState({ ...base, lastError: "network" }).kind).toBe("offline");
    expect(deriveSyncState({ ...base, lastError: "other", conflicts: 2 }).kind).toBe("error");
    expect(deriveSyncState({ ...base, conflicts: 2 }).kind).toBe("conflict");
  });

  it("syncing shows live progress from applied entries", () => {
    expect(deriveSyncState({ ...base, syncing: true }).label).toBe("Syncrypt: syncing…");
    expect(deriveSyncState({ ...base, syncing: true, appliedSoFar: 5 }).label).toBe(
      "Syncrypt: syncing (5)",
    );
  });

  it("tooltip carries last-sync time, counts, and the generation", () => {
    const view = deriveSyncState(base);
    expect(view.tooltip).toContain("120 notes, 14 attachments");
    expect(view.tooltip).toContain("generation #7");
    expect(view.tooltip).toContain("last sync");
    // Pending explains WHY, honestly.
    const pending = deriveSyncState({ ...base, status: { baseGeneration: 7, dirtyFiles: 3 } });
    expect(pending.tooltip).toContain("3 local change(s)");
  });

  it("conflict labels count the unresolved files", () => {
    expect(deriveSyncState({ ...base, conflicts: 3 }).label).toBe("Syncrypt: conflict (3)");
  });
});

describe("classifyCounts", () => {
  it("splits notes (.md/.canvas) from attachments", () => {
    expect(
      classifyCounts(["a.md", "b.canvas", "img.png", "doc.pdf", "dir/c.md"]),
    ).toEqual({ notes: 3, attachments: 2 });
  });
});
