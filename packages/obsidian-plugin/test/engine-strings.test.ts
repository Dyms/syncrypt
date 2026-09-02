// Nothing the engine says reaches the user in English by accident — ADR-0026.
//
// The engine emits codes and facts; the plugin owns every sentence. These
// tests are exhaustive BY CONSTRUCTION: each sample map is typed as
// Record<Code, …>, so adding a code to the engine without translating it
// fails to compile rather than shipping an English line to a Russian reader.

import { describe, expect, it } from "vitest";

import type { EngineNotice, EntryDetail, SyncOutcome } from "@syncrypt/core";
import { ReasonCode } from "@syncrypt/core";

import { stringsFor } from "../src/i18n.js";
import { LogBuffer, type LogLine } from "../src/log-buffer.js";
import { renderLine } from "../src/log-render.js";

const NOTICES: Record<EngineNotice["code"], EngineNotice> = {
  "sync-outcome": { code: "sync-outcome", outcome: "conflicts" },
  "pull-first": { code: "pull-first" },
  "confirmation-required": {
    code: "confirmation-required",
    reason: { code: "bulk-change", destructive: 7, total: 120 },
  },
  "confirmation-stale": { code: "confirmation-stale", newDestructive: 3 },
  "state-unreadable": { code: "state-unreadable", detail: "SyntaxError" },
  "dedup-probe-unavailable": {
    code: "dedup-probe-unavailable",
    path: "note.md",
    detail: "timeout",
  },
  "manifest-entries-forgotten": {
    code: "manifest-entries-forgotten",
    count: 4,
    generation: 12,
  },
  "deletions-paced": {
    code: "deletions-paced",
    discount: { destructive: 37, effective: 8, paced: 31, spanSeconds: 25_200 },
  },
  "fork-lost": { code: "fork-lost", generation: 42 },
  "storage-rolled-back": { code: "storage-rolled-back", remote: 17, base: 23 },
  "vault-written-by-newer": {
    code: "vault-written-by-newer",
    writer: "1.0.0-beta.10",
    self: "1.0.0-beta.9",
  },
  "vault-written-by-older": {
    code: "vault-written-by-older",
    writer: "1.0.0-beta.9",
    self: "1.0.0-beta.10",
  },
  "tombstones-expired": {
    code: "tombstones-expired",
    count: 12,
    graceSeconds: 30 * 24 * 60 * 60,
  },
  "storage-reclaimed": {
    code: "storage-reclaimed",
    deleted: 118,
    bytesFreed: 4_194_304,
    prunedManifests: 40,
    waiting: 3,
  },
};

const DETAILS: Record<EntryDetail["code"], EntryDetail> = {
  "conflict-copy-saved": { code: "conflict-copy-saved", copyPath: "note (copy).md" },
  "remote-edit-restored": { code: "remote-edit-restored" },
  "local-edit-kept": { code: "local-edit-kept" },
};

const OUTCOMES: Record<SyncOutcome, true> = {
  applied: true,
  "pull-first": true,
  "needs-confirmation": true,
  conflicts: true,
  "no-op": true,
  aborted: true,
  "rolled-back": true,
};

const en = stringsFor("en");
const ru = stringsFor("ru");

const line = (over: Partial<LogLine>): LogLine => ({ at: 0, level: "info", ...over });

describe("every engine notice is phrased in every language", () => {
  it("renders non-empty, and differently, in English and Russian", () => {
    for (const [code, notice] of Object.entries(NOTICES)) {
      const l = line({ notice });
      expect(renderLine(l, en), code).not.toBe("");
      expect(renderLine(l, ru), code).not.toBe("");
      expect(renderLine(l, ru), code).not.toBe(renderLine(l, en));
    }
  });

  it("every sync outcome has its own sentence in both languages", () => {
    for (const outcome of Object.keys(OUTCOMES) as SyncOutcome[]) {
      const l = line({ notice: { code: "sync-outcome", outcome } });
      expect(renderLine(l, en), outcome).not.toBe("");
      expect(renderLine(l, ru), outcome).not.toBe(renderLine(l, en));
    }
  });

  it("the numbers the engine reported survive into the sentence", () => {
    const l = line({
      notice: {
        code: "confirmation-required",
        reason: { code: "bulk-change", destructive: 7, total: 120 },
      },
    });
    for (const t of [en, ru]) {
      expect(renderLine(l, t)).toContain("7");
      expect(renderLine(l, t)).toContain("120");
    }
  });
});

describe("every applied change is phrased in every language", () => {
  it("a bare reason code renders in both", () => {
    for (const reason of Object.values(ReasonCode)) {
      const l = line({ level: "entry", reason, path: "note.md" });
      expect(renderLine(l, ru), reason).not.toBe(renderLine(l, en));
    }
  });

  it("each detail adds its own clause, and keeps the conflicted copy's path", () => {
    for (const [code, detail] of Object.entries(DETAILS)) {
      const l = line({ level: "entry", reason: ReasonCode.ConflictBothChanged, detail });
      const bare = renderLine(line({ level: "entry", reason: ReasonCode.ConflictBothChanged }), ru);
      expect(renderLine(l, ru), code).not.toBe(bare);
      expect(renderLine(l, ru), code).not.toBe(renderLine(l, en));
    }
    const withCopy = line({
      level: "entry",
      reason: ReasonCode.ConflictBothChanged,
      detail: { code: "conflict-copy-saved", copyPath: "note (copy).md" },
    });
    expect(renderLine(withCopy, ru)).toContain("note (copy).md");
  });
});

describe("the buffer keeps data, not prose", () => {
  it("stores codes and lets the view do the phrasing", () => {
    const buffer = new LogBuffer();
    buffer.entry({
      path: "note.md",
      kind: "conflict",
      reason: ReasonCode.ConflictBothChanged,
      detail: { code: "conflict-copy-saved", copyPath: "note (copy).md" },
    });
    buffer.notice({ code: "pull-first" });
    buffer.notice({ code: "state-unreadable", detail: "boom" });

    const [entry, pullFirst, unreadable] = buffer.all();
    expect(entry?.reason).toBe(ReasonCode.ConflictBothChanged);
    expect(entry?.detail).toEqual({ code: "conflict-copy-saved", copyPath: "note (copy).md" });
    // A warning reads as a warning; progress does not.
    expect(pullFirst?.level).toBe("info");
    expect(unreadable?.level).toBe("warn");
    // No English text was stored anywhere along the way.
    expect(buffer.all().every((l) => l.text === undefined)).toBe(true);
  });
});
