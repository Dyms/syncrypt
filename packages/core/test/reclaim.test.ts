// ADR-0030. The one operation nothing undoes gets the strictest tests in the
// suite: what may be deleted, what may never be, and the race that makes
// "unreferenced and old" the wrong rule.

import { describe, expect, it } from "vitest";

import {
  GC_MARK_KEY,
  markAfterSweep,
  OBJECTS_PREFIX,
  parseGcMark,
  planReclaim,
  reachableObjectKeys,
  retainedGenerations,
  serializeGcMark,
  type GcMark,
  type Manifest,
  type ManifestInStorage,
} from "../src/index.js";

const HOUR = 3600;
const GRACE = 24 * HOUR;
const NOW = 1_000_000;

const entry = (key: string) => ({
  hash: `b3:${key}`,
  size: 1,
  mtime: 1000,
  objectKey: key,
});

function manifestAt(opts: {
  generation: number;
  device?: string;
  files?: string[];
  history?: Record<string, string[]>;
}): ManifestInStorage {
  const device = opts.device ?? "dev-1";
  const files: Manifest["files"] = {};
  for (const key of opts.files ?? []) files[`${key.replace(/\W/g, "")}.md`] = entry(key);
  const manifest: Manifest = {
    version: 1,
    generation: opts.generation,
    device,
    updatedAt: 1000,
    files,
    tombstones: {},
  };
  if (opts.history !== undefined) {
    manifest.history = Object.fromEntries(
      Object.entries(opts.history).map(([path, keys]) => [path, keys.map(entry)]),
    );
  }
  return {
    key: `manifests/${String(opts.generation).padStart(9, "0")}-${device}.json`,
    generation: opts.generation,
    manifest,
  };
}

const obj = (key: string, size = 100) => ({ key, size });

const run = (over: Partial<Parameters<typeof planReclaim>[0]> = {}) =>
  planReclaim({
    now: NOW,
    graceSeconds: GRACE,
    generationsToKeep: 10,
    manifests: [],
    objects: [],
    mark: null,
    ...over,
  });

describe("reachability", () => {
  it("counts live entries AND retained prior versions", () => {
    const m = manifestAt({
      generation: 1,
      files: [`${OBJECTS_PREFIX}live`],
      history: { "note.md": [`${OBJECTS_PREFIX}old1`, `${OBJECTS_PREFIX}old2`] },
    });
    expect([...reachableObjectKeys([m.manifest as Manifest])].sort()).toEqual([
      `${OBJECTS_PREFIX}live`,
      `${OBJECTS_PREFIX}old1`,
      `${OBJECTS_PREFIX}old2`,
    ]);
  });

  it("retains GENERATIONS, so a fork loser's objects stay alive", () => {
    // Two manifests at generation 7 — the ADR-0006 §4 fork. Keeping the newest
    // manifest would strand the loser's objects while it re-plans.
    const kept = retainedGenerations([5, 6, 7, 7], 1);
    expect([...kept]).toEqual([7]);
    const plan = run({
      generationsToKeep: 1,
      manifests: [
        manifestAt({ generation: 7, device: "dev-a", files: [`${OBJECTS_PREFIX}a`] }),
        manifestAt({ generation: 7, device: "dev-b", files: [`${OBJECTS_PREFIX}b`] }),
        manifestAt({ generation: 6, device: "dev-a", files: [`${OBJECTS_PREFIX}old`] }),
      ],
      objects: [obj(`${OBJECTS_PREFIX}a`), obj(`${OBJECTS_PREFIX}b`), obj(`${OBJECTS_PREFIX}old`)],
      mark: { version: 1, updatedAt: 0, unreachableSince: { [`${OBJECTS_PREFIX}old`]: 0 } },
    });
    expect(plan.sweep).toEqual([`${OBJECTS_PREFIX}old`]);
    expect(plan.prunedManifests).toEqual(["manifests/000000006-dev-a.json"]);
  });

  it("a fork does not eat a retention slot", () => {
    // Two manifests at generation 7, one at 6, keeping TWO generations. Count
    // manifests instead of generations and generation 6 is pruned by the fork.
    const forked = [
      manifestAt({ generation: 7, device: "dev-a", files: [`${OBJECTS_PREFIX}a`] }),
      manifestAt({ generation: 7, device: "dev-b", files: [`${OBJECTS_PREFIX}b`] }),
      manifestAt({ generation: 6, device: "dev-a", files: [`${OBJECTS_PREFIX}six`] }),
    ];
    expect([...retainedGenerations([7, 7, 6], 2)].sort()).toEqual([6, 7]);
    const plan = run({
      generationsToKeep: 2,
      manifests: forked,
      objects: [obj(`${OBJECTS_PREFIX}six`)],
      mark: { version: 1, updatedAt: 0, unreachableSince: { [`${OBJECTS_PREFIX}six`]: 0 } },
    });
    expect(plan.prunedManifests).toEqual([]);
    expect(plan.sweep).toEqual([]); // generation 6 still points at it
  });
});

describe("mark, wait, sweep", () => {
  const manifests = [manifestAt({ generation: 3, files: [`${OBJECTS_PREFIX}live`] })];
  const objects = [obj(`${OBJECTS_PREFIX}live`), obj(`${OBJECTS_PREFIX}dead`, 4096)];

  it("a newly unreferenced object is NEVER swept on the first run", () => {
    const plan = run({ manifests, objects });
    expect(plan.sweep).toEqual([]);
    expect(plan.waiting).toBe(1);
    expect(plan.waitingBytes).toBe(4096);
    expect(plan.ripeAt).toBe(NOW + GRACE);
    expect(plan.nextMark.unreachableSince[`${OBJECTS_PREFIX}dead`]).toBe(NOW);
  });

  it("it goes once the grace window has passed", () => {
    const mark: GcMark = {
      version: 1,
      updatedAt: NOW - GRACE,
      unreachableSince: { [`${OBJECTS_PREFIX}dead`]: NOW - GRACE },
    };
    const plan = run({ manifests, objects, mark });
    expect(plan.sweep).toEqual([`${OBJECTS_PREFIX}dead`]);
    expect(plan.sweepBytes).toBe(4096);
    expect(plan.waiting).toBe(0);
    expect(plan.ripeAt).toBeNull();
  });

  it("one second short of the window is still not enough", () => {
    const mark: GcMark = {
      version: 1,
      updatedAt: 0,
      unreachableSince: { [`${OBJECTS_PREFIX}dead`]: NOW - GRACE + 1 },
    };
    expect(run({ manifests, objects, mark }).sweep).toEqual([]);
  });

  it("running the command again does not restart the clock", () => {
    const first = run({ manifests, objects, now: NOW - GRACE });
    const second = run({ manifests, objects, mark: first.nextMark });
    expect(second.nextMark.unreachableSince[`${OBJECTS_PREFIX}dead`]).toBe(NOW - GRACE);
    expect(second.sweep).toEqual([`${OBJECTS_PREFIX}dead`]);
  });
});

describe("the races that make 'unreferenced and old' the wrong rule", () => {
  it("an object adopted between mark and sweep is spared", () => {
    // The dedup probe in applyPushOps: the user recreates a note whose content
    // once existed, the push skips the upload and publishes a manifest that
    // points straight at the object we were about to delete.
    const mark: GcMark = {
      version: 1,
      updatedAt: 0,
      unreachableSince: { [`${OBJECTS_PREFIX}revived`]: NOW - 10 * GRACE },
    };
    const plan = run({
      manifests: [manifestAt({ generation: 9, files: [`${OBJECTS_PREFIX}revived`] })],
      objects: [obj(`${OBJECTS_PREFIX}revived`)],
      mark,
    });
    expect(plan.sweep).toEqual([]);
    expect(plan.waiting).toBe(0);
  });

  it("a mark entry for an object that is gone does not resurrect it as a candidate", () => {
    const mark: GcMark = {
      version: 1,
      updatedAt: 0,
      unreachableSince: { [`${OBJECTS_PREFIX}already-gone`]: 0 },
    };
    const plan = run({ manifests: [manifestAt({ generation: 1 })], objects: [], mark });
    expect(plan.sweep).toEqual([]);
    expect(plan.nextMark.unreachableSince).toEqual({});
  });
});

describe("a retained manifest that was not loaded is fatal, never 'unreachable'", () => {
  it("refuses to plan rather than treating its objects as garbage", () => {
    // Only the retained generations are fetched (they are the only ones whose
    // contents matter). If one of them is missing, everything it references
    // looks unreferenced — the exact shape of a mass deletion. Fail closed.
    expect(() =>
      run({
        generationsToKeep: 1,
        manifests: [{ key: "manifests/000000009-dev-a.json", generation: 9 }],
        objects: [obj(`${OBJECTS_PREFIX}live`)],
      }),
    ).toThrow(/retained generation 9/);
  });

  it("a PRUNED generation needs no manifest at all — only its key", () => {
    const plan = run({
      generationsToKeep: 1,
      manifests: [
        manifestAt({ generation: 9, files: [`${OBJECTS_PREFIX}live`] }),
        { key: "manifests/000000008-dev-a.json", generation: 8 }, // never fetched
      ],
      objects: [obj(`${OBJECTS_PREFIX}live`), obj(`${OBJECTS_PREFIX}dead`)],
      mark: { version: 1, updatedAt: 0, unreachableSince: { [`${OBJECTS_PREFIX}dead`]: 0 } },
    });
    expect(plan.prunedManifests).toEqual(["manifests/000000008-dev-a.json"]);
    expect(plan.sweep).toEqual([`${OBJECTS_PREFIX}dead`]);
  });
});

describe("what is structurally out of reach", () => {
  it("NOTHING outside objects/ is ever a candidate — the keyfile above all", () => {
    // meta/keyfile-params.json holds the Argon2id salt. Delete it and every
    // device is locked out of a bucket that still holds all the data.
    const mark: GcMark = {
      version: 1,
      updatedAt: 0,
      unreachableSince: {
        "meta/keyfile-params.json": 0,
        [GC_MARK_KEY]: 0,
        "manifests/000000001-dev-1.json": 0,
        "something-else": 0,
      },
    };
    const plan = run({
      // A vault where every single file was deleted: nothing is reachable.
      manifests: [manifestAt({ generation: 1 })],
      objects: [
        obj("meta/keyfile-params.json"),
        obj(GC_MARK_KEY),
        obj("manifests/000000001-dev-1.json"),
        obj("something-else"),
      ],
      mark,
    });
    expect(plan.sweep).toEqual([]);
    expect(plan.waiting).toBe(0);
  });

  it("manifests are pruned by the generation rule, never by reachability", () => {
    const manifests = Array.from({ length: 15 }, (_, i) =>
      manifestAt({ generation: i + 1, files: [`${OBJECTS_PREFIX}g${String(i + 1)}`] }),
    );
    const plan = run({ manifests, generationsToKeep: 10 });
    expect(plan.prunedManifests).toHaveLength(5);
    expect(plan.prunedManifests).toContain("manifests/000000005-dev-1.json");
    expect(plan.prunedManifests).not.toContain("manifests/000000006-dev-1.json");
    expect(plan.generation).toBe(15);
  });

  it("keeping fewer generations makes more objects unreachable, not fewer", () => {
    const manifests = Array.from({ length: 5 }, (_, i) =>
      manifestAt({ generation: i + 1, files: [`${OBJECTS_PREFIX}g${String(i + 1)}`] }),
    );
    const objects = manifests.map((_, i) => obj(`${OBJECTS_PREFIX}g${String(i + 1)}`));
    expect(run({ manifests, objects, generationsToKeep: 5 }).waiting).toBe(0);
    expect(run({ manifests, objects, generationsToKeep: 1 }).waiting).toBe(4);
    // Never zero: a vault must always keep at least its newest generation.
    expect(run({ manifests, objects, generationsToKeep: 0 }).prunedManifests).toHaveLength(4);
  });
});

describe("the mark survives a round trip", () => {
  it("serializes and parses back identically, keys sorted", () => {
    const mark: GcMark = {
      version: 1,
      updatedAt: NOW,
      unreachableSince: { [`${OBJECTS_PREFIX}b`]: 2, [`${OBJECTS_PREFIX}a`]: 1 },
    };
    const bytes = serializeGcMark(mark);
    expect(new TextDecoder().decode(bytes).indexOf(`${OBJECTS_PREFIX}a`)).toBeLessThan(
      new TextDecoder().decode(bytes).indexOf(`${OBJECTS_PREFIX}b`),
    );
    expect(parseGcMark(bytes)).toEqual(mark);
  });

  it("anything that is not a valid mark parses as absent, never as empty truth", () => {
    const bad = ["not json", "[]", '{"version":2}', '{"version":1}', "null"];
    for (const text of bad) {
      expect(parseGcMark(new TextEncoder().encode(text)), text).toBeNull();
    }
  });

  it("markAfterSweep drops exactly what was deleted and keeps what waits", () => {
    const plan = run({
      manifests: [manifestAt({ generation: 1 })],
      objects: [obj(`${OBJECTS_PREFIX}old`), obj(`${OBJECTS_PREFIX}new`)],
      mark: {
        version: 1,
        updatedAt: 0,
        unreachableSince: { [`${OBJECTS_PREFIX}old`]: NOW - GRACE },
      },
    });
    expect(plan.sweep).toEqual([`${OBJECTS_PREFIX}old`]);
    expect(Object.keys(markAfterSweep(plan).unreachableSince)).toEqual([
      `${OBJECTS_PREFIX}new`,
    ]);
  });
});
