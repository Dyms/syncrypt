// Post-fix review: ADR-0066 — "Lock ends what the session started"; the
// maintenance wrapper's current() is checked before a dialog and after its
// answer, but not during or after the operation itself. reclaimStorage and
// releaseForgotten are called with `undefined` for the signal, so a lock that
// lands while they run cancels nothing; and what follows them (a "done"
// notice, accept's follow-up sync) runs into the locked — or the next —
// session.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReclaimPlan } from "@syncrypt/core";

import { EN_STRINGS } from "../../src/i18n.js";
import { PassphraseModal } from "../../src/unlock.js";
import { PreviousSessionBusy } from "../../src/unlock-error.js";
import { Modal, Notice, resetStub } from "../support/obsidian-stub.js";
import {
  engineOf,
  mainStore,
  makeDevice,
  PASS,
  S3_DATA,
  settle,
  unlock,
  waitFor,
  World,
} from "../support/plugin-harness.js";

beforeEach(() => {
  resetStub();
});

const plan: ReclaimPlan = {
  sweep: ["objects/aa"],
  sweepBytes: 10,
  waiting: 0,
  waitingBytes: 0,
  ripeAt: null,
  prunedManifests: [],
  nextMark: { version: 1, unreachableSince: {} } as never,
  generation: 3,
};

describe("Q: a lock during a maintenance operation", () => {
  it("reclaim: the sweep gets no signal, so Lock cannot stop it; 'done' is said after Lock", async () => {
    const me = await makeDevice(new World(), { ...S3_DATA, autoSync: { enabled: false } });
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const engine = engineOf(me);
    vi.spyOn(engine, "previewReclaim").mockResolvedValue(plan);
    let signalSeen: AbortSignal | undefined;
    let abortedByLock = false;
    vi.spyOn(engine, "reclaimStorage").mockImplementation((signal) => {
      signalSeen = signal;
      me.plugin.lock(); // the person locks while objects are being deleted
      abortedByLock = signal?.aborted === true;
      return Promise.resolve({ deleted: ["objects/aa"], bytesFreed: 10, prunedManifests: 0, waiting: 0, ripeAt: null });
    });
    vi.spyOn(me.plugin as unknown as { ask(o: unknown): Promise<unknown> }, "ask").mockResolvedValue(true);
    await me.plugin.reclaimStorage();
    expect({
      abortable: signalSeen !== undefined && abortedByLock,
      doneAfterLock: Notice.shown.includes(EN_STRINGS.reclaimModal.done(1, "10 B")),
    }).toEqual({ abortable: true, doneAfterLock: false }); // Before ADR-0081: { false, true }
  });

  it("accept: a Lock during the accept opens a passphrase dialog nobody asked for", async () => {
    const world = new World();
    const me = await makeDevice(world, { ...S3_DATA, autoSync: { enabled: false } });
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    for (let i = 0; i < 3; i++) {
      me.adapter.now += 1000;
      me.adapter.setFile(`n${String(i)}.md`, `v${String(i)}`);
      await engineOf(me).sync();
    }
    const store = mainStore(world);
    const newest = store.keys().filter((k) => k.includes("/manifests/")).sort().at(-1);
    if (newest === undefined) throw new Error("no manifest");
    await store.delete(newest);
    vi.spyOn(me.plugin as unknown as { ask(o: unknown): Promise<unknown> }, "ask").mockResolvedValue(true);
    const engine = engineOf(me);
    const real = engine.acceptRolledBack.bind(engine);
    vi.spyOn(engine, "acceptRolledBack").mockImplementation(async () => {
      const p = real();
      me.plugin.lock();
      return p;
    });
    Modal.opened.length = 0;
    await me.plugin.acceptStorage();
    const popped = Modal.opened.filter((m) => m instanceof PassphraseModal).length;
    expect({
      popped,
      accepted: Notice.shown.includes(EN_STRINGS.notices.storageAccepted),
    }).toEqual({ popped: 0, accepted: false }); // failed before ADR-0081
  });

  it("the next unlock does not open beside a command still running (ADR-0081)", async () => {
    const me = await makeDevice(new World(), { ...S3_DATA, autoSync: { enabled: false } });
    me.adapter.setFile("seed.md", "published, so the passphrase can be checked");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const engine = engineOf(me);
    vi.spyOn(engine, "previewReclaim").mockResolvedValue(plan);
    let release = (): void => undefined;
    let inside = false;
    vi.spyOn(engine, "reclaimStorage").mockImplementation(async () => {
      inside = true;
      await new Promise<void>((r) => (release = r)); // a sweep request that hangs
      return { deleted: [], bytesFreed: 0, prunedManifests: 0, waiting: 0, ripeAt: null };
    });
    vi.spyOn(me.plugin as unknown as { ask(o: unknown): Promise<unknown> }, "ask").mockResolvedValue(true);
    const command = me.plugin.reclaimStorage();
    await waitFor(() => inside, "the sweep to be inside its request");
    me.plugin.lock();
    await expect(unlock(me.plugin, PASS)).rejects.toBeInstanceOf(PreviousSessionBusy);
    release();
    await command;
    await unlock(me.plugin, PASS);
    expect(me.plugin.isUnlocked()).toBe(true);
  });

  it("the read-only previews get the command's signal too (ADR-0082)", async () => {
    const me = await makeDevice(new World(), { ...S3_DATA, autoSync: { enabled: false } });
    me.adapter.setFile("seed.md", "published");
    await unlock(me.plugin, PASS, true);
    await settle(me.plugin);
    const engine = engineOf(me);
    const seen: Record<string, boolean> = {};
    vi.spyOn(engine, "listUncarried").mockImplementation((signal) => {
      me.plugin.lock();
      seen.review = signal?.aborted === true;
      return Promise.resolve([]);
    });
    await me.plugin.reviewManifest();
    await unlock(me.plugin, PASS);
    vi.spyOn(engineOf(me), "previewRelease").mockImplementation((signal) => {
      me.plugin.lock();
      seen.release = signal?.aborted === true;
      return Promise.resolve([]);
    });
    await me.plugin.releaseForgotten();
    expect(seen).toEqual({ review: true, release: true });
  });
});
