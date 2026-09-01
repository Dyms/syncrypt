// The beta.8 dead end, pinned: every surface that mentions a conflict must be
// able to NAME the file and the conflicted copy beside it. A count is not
// actionable advice.

import { describe, expect, it } from "vitest";

import { ReasonCode, type SyncReportEntry } from "@syncrypt/core";

import { collectConflicts, conflictCopyFor, shortlist } from "../src/conflict-report.js";
import { stringsFor } from "../src/i18n.js";
import { deriveSyncState, type SyncStateInput } from "../src/sync-state.js";

const SHARED = ".obsidian/syncrypt-config-sync.json";
const SHARED_COPY = ".obsidian/syncrypt-config-sync (conflicted copy from phone 2026-09-01).json";

const entry = (over: Partial<SyncReportEntry>): SyncReportEntry => ({
  path: "note.md",
  kind: "conflict",
  reason: ReasonCode.ConflictBothChanged,
  ...over,
});

describe("collectConflicts", () => {
  it("pairs each conflicted path with the copy the engine parked beside it", () => {
    const items = collectConflicts({
      conflicts: ["a.md", SHARED],
      entries: [
        entry({ path: "a.md", detail: { code: "conflict-copy-saved", copyPath: "a (copy).md" } }),
        entry({ path: "unrelated.md", reason: ReasonCode.NewLocalFile, kind: "upload" }),
        entry({ path: SHARED, detail: { code: "conflict-copy-saved", copyPath: SHARED_COPY } }),
      ],
    });
    expect(items).toEqual([
      { path: "a.md", copyPath: "a (copy).md" },
      { path: SHARED, copyPath: SHARED_COPY },
    ]);
  });

  it("still names a conflict that has no copy yet, and collapses duplicates", () => {
    const items = collectConflicts({ conflicts: ["a.md", "a.md"], entries: [] });
    expect(items).toEqual([{ path: "a.md" }]);
  });

  it("conflictCopyFor finds the copy for one path and nothing for the others", () => {
    const report = {
      conflicts: [SHARED],
      entries: [entry({ path: SHARED, detail: { code: "conflict-copy-saved", copyPath: SHARED_COPY } })],
    };
    expect(conflictCopyFor(report, SHARED)).toBe(SHARED_COPY);
    expect(conflictCopyFor(report, "other.md")).toBeUndefined();
  });
});

describe("shortlist", () => {
  it("keeps everything when it fits, and counts the rest when it does not", () => {
    expect(shortlist(["a", "b"], 5)).toEqual({ shown: ["a", "b"], more: 0 });
    expect(shortlist(["a", "b", "c"], 2)).toEqual({ shown: ["a", "b"], more: 1 });
  });
});

describe("the status tooltip names the files", () => {
  const base: SyncStateInput = {
    locked: false,
    syncing: false,
    appliedSoFar: 0,
    onLine: true,
    status: { baseGeneration: 7, dirtyFiles: 0 },
    lastOutcome: "conflicts",
    lastSyncAt: Date.parse("2026-09-01T12:49:13Z"),
    lastError: null,
    conflicts: [],
    now: Date.parse("2026-09-01T12:50:00Z"),
    counts: null,
  };

  it("lists the conflicting paths, in both languages", () => {
    for (const t of [stringsFor("en").status, stringsFor("ru").status]) {
      const view = deriveSyncState({ ...base, conflicts: ["Входящие/note.md", "b.md"] }, t);
      expect(view.kind).toBe("conflict");
      expect(view.tooltip).toContain("Входящие/note.md");
      expect(view.tooltip).toContain("b.md");
    }
  });

  it("stops listing after five and says how many are left", () => {
    const many = ["1.md", "2.md", "3.md", "4.md", "5.md", "6.md", "7.md"];
    const view = deriveSyncState({ ...base, conflicts: many });
    expect(view.tooltip).toContain("5.md");
    expect(view.tooltip).not.toContain("6.md");
    expect(view.tooltip).toContain("2 more");
  });
});

describe("the config-sync conflict line says which files and what to do", () => {
  it("names the shared profile AND the copy, in both languages", () => {
    for (const lang of ["en", "ru"] as const) {
      const line = stringsFor(lang).log.configSyncConflicted(SHARED, SHARED_COPY);
      expect(line, lang).toContain(SHARED);
      expect(line, lang).toContain(SHARED_COPY);
    }
    // Two languages, two sentences — no English leaking to a Russian reader.
    expect(stringsFor("ru").log.configSyncConflicted(SHARED, SHARED_COPY)).not.toBe(
      stringsFor("en").log.configSyncConflicted(SHARED, SHARED_COPY),
    );
  });

  it("still names the shared profile when no copy was written", () => {
    for (const lang of ["en", "ru"] as const) {
      const line = stringsFor(lang).log.configSyncConflicted(SHARED, undefined);
      expect(line, lang).toContain(SHARED);
      expect(line, lang).not.toContain("undefined");
    }
  });
});

describe("the sync-log summary line", () => {
  it("names the conflicting paths and counts the overflow", () => {
    for (const lang of ["en", "ru"] as const) {
      const line = stringsFor(lang).log.conflictsFound(["a.md", "b.md"], 3);
      expect(line, lang).toContain("a.md");
      expect(line, lang).toContain("b.md");
      expect(line, lang).toContain("3");
    }
  });
});

describe("a single conflict is named in the notice itself", () => {
  it("has its own phrasing carrying the path", () => {
    for (const lang of ["en", "ru"] as const) {
      expect(stringsFor(lang).notices.conflictOne("Входящие/note.md"), lang).toContain(
        "Входящие/note.md",
      );
    }
  });
});
