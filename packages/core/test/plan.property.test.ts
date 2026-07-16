// Property-based planner tests — the invariants that justify Syncrypt's
// existence, asserted over randomized three-way states:
//
//   NO SILENT OVERWRITE — no op ever writes over or deletes a locally-changed
//   file, and no upload ever replaces a remotely-changed version.
//   NO DATA LOSS — destructive ops only touch content already recorded in base.
//   DETERMINISM — plan() is a pure function with stable ordering.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  DEFAULT_PLAN_OPTIONS,
  plan,
  type FileDescriptor,
  type Manifest,
  type SyncPlan,
  type VaultPath,
} from "../src/index.js";
import { entry } from "./helpers.js";

const PATHS: VaultPath[] = ["a.md", "b.md", "dir/c.md", "dir/sub/d.md", "e.md"];
const HASHES = ["b3:1", "b3:2", "b3:3"];

/** One side's state for a path: a hash, a tombstone, or absent. */
const sideArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...HASHES) },
  { weight: 1, arbitrary: fc.constant("†" as const) },
  { weight: 2, arbitrary: fc.constant(null) },
);

const stateArb = fc.record({
  perPath: fc.array(fc.tuple(sideArb, sideArb, sideArb), {
    minLength: PATHS.length,
    maxLength: PATHS.length,
  }),
  baseGen: fc.integer({ min: 1, max: 5 }),
  genAhead: fc.integer({ min: 0, max: 2 }),
  baseNull: fc.boolean(),
  remoteNull: fc.boolean(),
});

interface Scenario {
  local: FileDescriptor[];
  base: Manifest | null;
  remote: Manifest | null;
}

function build(s: typeof stateArb extends fc.Arbitrary<infer T> ? T : never): Scenario {
  const local: FileDescriptor[] = [];
  const base: Manifest = {
    version: 1,
    generation: s.baseGen,
    device: "dev-base",
    updatedAt: 1000,
    files: {},
    tombstones: {},
  };
  const remote: Manifest = {
    version: 1,
    generation: s.baseGen + s.genAhead,
    device: "dev-remote",
    updatedAt: 1000,
    files: {},
    tombstones: {},
  };
  s.perPath.forEach(([l, b, r], i) => {
    const path = PATHS[i];
    if (path === undefined) return;
    if (l !== null && l !== "†") local.push({ path, hash: l, size: 1, mtime: 1 });
    if (b === "†") base.tombstones[path] = { deletedAt: 900, device: "dev-base" };
    else if (b !== null) base.files[path] = entry(b);
    if (r === "†") remote.tombstones[path] = { deletedAt: 900, device: "dev-remote" };
    else if (r !== null) remote.files[path] = entry(r);
  });
  return {
    local,
    base: s.baseNull ? null : base,
    remote: s.remoteNull ? null : remote,
  };
}

function runPlan({ local, base, remote }: Scenario): SyncPlan {
  return plan(local, base, remote, DEFAULT_PLAN_OPTIONS);
}

describe("planner invariants (property-based)", () => {
  it("NO SILENT OVERWRITE: nothing destructive touches a locally-changed file", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const scenario = build(s);
        const p = runPlan(scenario);
        for (const op of p.operations) {
          if (op.kind === "download" && op.localHash !== undefined) {
            // Replacing a local file is only allowed when it is UNCHANGED vs base.
            expect(op.localHash).toBe(op.baseHash);
          }
          if (op.kind === "delete-local") {
            expect(op.localHash).toBe(op.baseHash);
          }
        }
      }),
    );
  });

  it("NO REMOTE LOSS: an upload never replaces a remotely-changed version", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const p = runPlan(build(s));
        for (const op of p.operations) {
          if (op.kind === "upload" && op.remoteHash !== undefined) {
            expect(op.remoteHash).toBe(op.baseHash);
          }
          if (op.kind === "delete-remote") {
            // Tombstoning remotely requires the remote version to be exactly
            // what this device last synced (base) and the local copy gone.
            expect(op.localHash).toBeUndefined();
            expect(op.remoteHash).toBe(op.baseHash);
          }
        }
      }),
    );
  });

  it("both-changed-differently always surfaces as a conflict, never an op", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const scenario = build(s);
        const p = runPlan(scenario);
        const localBy = new Map(scenario.local.map((f) => [f.path, f.hash]));
        for (const path of PATHS) {
          const l = localBy.get(path);
          const b = scenario.base?.files[path]?.hash;
          const r = scenario.remote?.files[path]?.hash;
          if (l !== undefined && r !== undefined && l !== r && l !== b && r !== b) {
            const op = p.operations.find((o) => o.path === path);
            expect(op?.kind).toBe("conflict");
          }
        }
      }),
    );
  });

  it("determinism: same inputs → identical plan; ops unique per path and ordered", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const scenario = build(s);
        const p1 = runPlan(scenario);
        const p2 = runPlan(scenario);
        expect(p2).toEqual(p1);
        const seen = new Set(p1.operations.map((o) => o.path));
        expect(seen.size).toBe(p1.operations.length);
      }),
    );
  });

  it("every operation carries a non-empty reason, and kinds match reasons", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const p = runPlan(build(s));
        for (const op of p.operations) {
          expect(op.reason.length).toBeGreaterThan(0);
          const isConflictReason = op.reason.includes("conflict");
          expect(op.kind === "conflict").toBe(isConflictReason);
        }
      }),
    );
  });

  it("breaker never fires on a purely additive plan", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const p = runPlan(build(s));
        const destructive = p.operations.some(
          (o) =>
            o.kind === "delete-local" ||
            o.kind === "delete-remote" ||
            (o.kind === "download" && o.localHash !== undefined),
        );
        if (!destructive) expect(p.requiresConfirmation).toBe(false);
      }),
    );
  });
});
