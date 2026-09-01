// ADR-0029: the bulk-change breaker judges the BURST at the source, not the
// size of this plan. A plan is only as big as the gap since this device last
// synced — that is a fact about a sync schedule, not about what anyone did.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLAN_OPTIONS,
  peakBurst,
  plan,
  type Manifest,
  type PlanOptions,
} from "../src/index.js";
import { localFiles } from "./helpers.js";

const VAULT_SIZE = 3000;
const PHONE = "dev-phone";
const LAPTOP = "dev-laptop";

/** A vault of `VAULT_SIZE` notes, the first `deleted` of which are gone remotely. */
function scenario(opts: {
  deleted: number;
  /** Seconds between consecutive deletions at the source. */
  gap: number;
  device?: string | ((i: number) => string);
  firstAt?: number;
}): { local: ReturnType<typeof localFiles>; base: Manifest; remote: Manifest } {
  const all: Record<string, string> = {};
  for (let i = 0; i < VAULT_SIZE; i++) all[`note-${String(i)}.md`] = `b3:${String(i)}`;

  const base: Manifest = {
    version: 1,
    generation: 1,
    device: PHONE,
    updatedAt: 1000,
    files: Object.fromEntries(
      Object.entries(all).map(([p, h]) => [p, { hash: h, size: 1, mtime: 1000, objectKey: p }]),
    ),
    tombstones: {},
  };

  const files = { ...base.files };
  const tombstones: Manifest["tombstones"] = {};
  const at0 = opts.firstAt ?? 1_000_000;
  for (let i = 0; i < opts.deleted; i++) {
    const path = `note-${String(i)}.md`;
    delete files[path];
    const device =
      typeof opts.device === "function" ? opts.device(i) : (opts.device ?? PHONE);
    tombstones[path] = { deletedAt: at0 + i * opts.gap, device };
  }

  const remote: Manifest = { ...base, generation: 2, files, tombstones };
  // Everything still on disk here — this device has not applied the deletions.
  return { local: localFiles(all), base, remote };
}

const run = (s: ReturnType<typeof scenario>, over: Partial<PlanOptions> = {}) =>
  plan(s.local, s.base, s.remote, { ...DEFAULT_PLAN_OPTIONS, ...over });

describe("the case that shipped in beta.8", () => {
  it("a day of one-by-one deletions on the phone does NOT stop the desktop", () => {
    // 37 notes, roughly one every 12 minutes across ~7 hours.
    const p = run(scenario({ deleted: 37, gap: 12 * 60 }));
    expect(p.operations.filter((o) => o.kind === "delete-local")).toHaveLength(37);
    expect(p.requiresConfirmation).toBe(false);
    // …and it says so, rather than swallowing 37 deletions in silence.
    expect(p.pacingDiscount).toEqual({
      destructive: 37,
      effective: 1,
      paced: 37,
      spanSeconds: 36 * 12 * 60,
    });
  });

  it("the SAME 37 deletions written at one instant still stop it", () => {
    const p = run(scenario({ deleted: 37, gap: 0 }));
    expect(p.requiresConfirmation).toBe(true);
    expect(p.confirmationReason).toEqual({
      code: "bulk-change",
      destructive: 37,
      total: VAULT_SIZE,
    });
    expect(p.pacingDiscount).toBeUndefined();
  });

  it("a wipe is a wipe however long the device sat offline first", () => {
    // Every tombstone from one push carries the same publish time (ADR-0029).
    expect(run(scenario({ deleted: 1200, gap: 0 })).requiresConfirmation).toBe(true);
  });
});

describe("what pacing does and does not excuse", () => {
  it("deletions inside one window are one burst, and a burst is judged in full", () => {
    // 25 deletions spread over 4 minutes: still inside the 300 s window.
    expect(run(scenario({ deleted: 25, gap: 10 })).requiresConfirmation).toBe(true);
  });

  it("the window is a knob, not a constant", () => {
    const s = scenario({ deleted: 30, gap: 10 * 60 }); // one every 10 minutes
    expect(run(s).requiresConfirmation).toBe(false);
    // Call a 24-hour window "one burst" and the whole day collapses into it.
    expect(run(s, { deletionBurstWindow: 86_400 }).requiresConfirmation).toBe(true);
  });

  it("two devices tidying at once are two people, not one accident", () => {
    // 30 deletions 10 s apart, alternating devices: 15 per device inside the
    // window — under the 20-file threshold, so no prompt.
    const s = scenario({ deleted: 30, gap: 10, device: (i) => (i % 2 === 0 ? PHONE : LAPTOP) });
    expect(run(s).requiresConfirmation).toBe(false);
    // The same 30, at the same pace, all from ONE device is a burst of 30.
    expect(run(scenario({ deleted: 30, gap: 10 })).requiresConfirmation).toBe(true);
  });

  it("deletions with no tombstone behind them are never discounted", () => {
    // A remote manifest that dropped 30 entries WITHOUT tombstones is an
    // anomaly (ADR-0027), so these are not delete-local ops at all — but the
    // guarantee under test is that pacing needs a tombstone to key off.
    const s = scenario({ deleted: 30, gap: 12 * 60 });
    const stripped: Manifest = { ...s.remote, tombstones: {} };
    const p = plan(s.local, s.base, stripped, DEFAULT_PLAN_OPTIONS);
    expect(p.operations.some((o) => o.kind === "delete-local")).toBe(false);
  });

  it("this device's OWN deletions are never discounted — there is no clock on them", () => {
    // 30 files gone locally, still live remotely → delete-remote ops. The
    // engine never saw when they went; it only sees that they are absent.
    const all: Record<string, string> = {};
    for (let i = 0; i < VAULT_SIZE; i++) all[`note-${String(i)}.md`] = `b3:${String(i)}`;
    const base: Manifest = {
      version: 1,
      generation: 1,
      device: PHONE,
      updatedAt: 1000,
      files: Object.fromEntries(
        Object.entries(all).map(([p, h]) => [p, { hash: h, size: 1, mtime: 1000, objectKey: p }]),
      ),
      tombstones: {},
    };
    const survivors = { ...all };
    for (let i = 0; i < 30; i++) delete survivors[`note-${String(i)}.md`];

    const p = plan(localFiles(survivors), base, base, DEFAULT_PLAN_OPTIONS);
    expect(p.operations.filter((o) => o.kind === "delete-remote")).toHaveLength(30);
    expect(p.requiresConfirmation).toBe(true);
  });

  it("a mass overwrite is never discounted — an entry's mtime is the FILE's, not the change's", () => {
    // The restic-restore shape: every file rewritten remotely, mtimes years
    // apart. Pacing on those would disarm the breaker for exactly the case it
    // exists for (ADR-0029 §2).
    const local: Record<string, string> = {};
    const remoteFiles: Record<string, { hash: string; size: number; mtime: number; objectKey: string }> = {};
    for (let i = 0; i < VAULT_SIZE; i++) {
      const path = `note-${String(i)}.md`;
      local[path] = `b3:${String(i)}`;
      remoteFiles[path] = {
        hash: i < 40 ? `b3:restored-${String(i)}` : `b3:${String(i)}`,
        size: 1,
        // One "changed" file per day, going back over a month.
        mtime: 1000 + i * 86_400,
        objectKey: path,
      };
    }
    const base: Manifest = {
      version: 1,
      generation: 1,
      device: PHONE,
      updatedAt: 1000,
      files: Object.fromEntries(
        Object.entries(local).map(([p, h]) => [p, { hash: h, size: 1, mtime: 1000, objectKey: p }]),
      ),
      tombstones: {},
    };
    const remote: Manifest = { ...base, generation: 2, files: remoteFiles };

    const p = plan(localFiles(local), base, remote, DEFAULT_PLAN_OPTIONS);
    expect(p.operations.filter((o) => o.kind === "download")).toHaveLength(40);
    expect(p.requiresConfirmation).toBe(true);
  });

  it("nothing destructive means nothing to discount", () => {
    const p = run(scenario({ deleted: 0, gap: 0 }));
    expect(p.requiresConfirmation).toBe(false);
    expect(p.pacingDiscount).toBeUndefined();
  });
});

describe("peakBurst", () => {
  const d = (at: number, device = PHONE) => ({ at, device });

  it("is zero for nothing and one for a single deletion", () => {
    expect(peakBurst([], 300)).toBe(0);
    expect(peakBurst([d(5)], 300)).toBe(1);
  });

  it("counts the densest window, not the first or the last", () => {
    // 0, then a cluster of four around 10 000.
    const times = [d(0), d(10_000), d(10_050), d(10_100), d(10_150), d(30_000)];
    expect(peakBurst(times, 300)).toBe(4);
  });

  it("is inclusive at the window edge — exactly `window` apart is one burst", () => {
    expect(peakBurst([d(0), d(300)], 300)).toBe(2);
    expect(peakBurst([d(0), d(301)], 300)).toBe(1);
  });

  it("never merges devices, and is order-independent", () => {
    const mixed = [d(0, PHONE), d(10, LAPTOP), d(20, PHONE), d(30, LAPTOP)];
    expect(peakBurst(mixed, 300)).toBe(2);
    expect(peakBurst([...mixed].reverse(), 300)).toBe(2);
  });
});
