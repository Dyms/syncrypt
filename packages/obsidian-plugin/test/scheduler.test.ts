// AutoSyncScheduler — debounce, coalescing, minimum-interval guard (RFC-0004
// §Resource-aware auto-sync), on a fully fake timer host.

import { describe, expect, it } from "vitest";

import { AutoSyncScheduler, type TimerHost } from "../src/scheduler.js";

class FakeTimers implements TimerHost {
  current = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  set(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + ms, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clear(id: ReturnType<typeof setTimeout>): void {
    this.timers.delete(id as unknown as number);
  }
  now(): number {
    return this.current;
  }
  /** Advance time, firing due timers in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.current = timer.at;
      timer.fn();
    }
    this.current = target;
  }
}

// periodicMs: 0 keeps the existing cases about the DEBOUNCE path only; the
// idle-pull timer has its own block at the bottom.
const OPTS = { debounceMs: 15_000, minIntervalMs: 30_000, retryMs: 60_000, periodicMs: 0 };

describe("AutoSyncScheduler", () => {
  it("fires once after the debounce window, coalescing bursts", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, OPTS, timers);
    s.noteChange();
    timers.advance(5_000);
    s.noteChange(); // burst — resets the window
    timers.advance(5_000);
    s.noteChange();
    timers.advance(14_999);
    expect(fired).toBe(0);
    timers.advance(1);
    expect(fired).toBe(1);
    timers.advance(60_000);
    expect(fired).toBe(1); // no changes → no more syncs
  });

  it("respects the minimum interval after a recent sync, without dropping changes", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, OPTS, timers);

    s.noteSyncStarted(); // a manual sync just ran at t=0
    s.noteChange();
    timers.advance(15_000); // debounce elapsed, but only 15s since last sync
    expect(fired).toBe(0);
    timers.advance(14_999); // t=29 999 — still inside the 30s guard
    expect(fired).toBe(0);
    timers.advance(1); // t=30 000 — guard satisfied, the change syncs now
    expect(fired).toBe(1);
  });

  it("dispose cancels pending work", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, OPTS, timers);
    s.noteChange();
    s.dispose();
    timers.advance(120_000);
    expect(fired).toBe(0);
    s.noteChange(); // after dispose: inert
    timers.advance(120_000);
    expect(fired).toBe(0);
  });
});

// ADR-0047. A trigger the client declines is a trigger deferred, and an open
// window eventually pulls even when nothing was edited here.
describe("a declined trigger comes back", () => {
  it("re-arms without touching the minimum-interval guard", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, OPTS, timers);

    s.noteChange();
    timers.advance(15_000);
    expect(fired).toBe(1); // fired… and the client declined it (offline)
    s.retryLater();

    timers.advance(59_999);
    expect(fired).toBe(1);
    timers.advance(1);
    expect(fired).toBe(2); // asked again, with no new edit
  });

  it("keeps asking until the client stops declining", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, OPTS, timers);
    s.noteChange();
    timers.advance(15_000);
    for (let i = 0; i < 5; i++) {
      s.retryLater();
      timers.advance(60_000);
    }
    expect(fired).toBe(6);
  });

  it("stops on dispose", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, OPTS, timers);
    s.retryLater();
    s.dispose();
    timers.advance(600_000);
    expect(fired).toBe(0);
  });
});

describe("the idle pull", () => {
  const PERIODIC = { ...OPTS, periodicMs: 900_000 };

  it("fires with no local edit at all", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, PERIODIC, timers);
    s.armPeriodic();
    timers.advance(899_999);
    expect(fired).toBe(0);
    timers.advance(1);
    expect(fired).toBe(1);
  });

  it("is pushed back by every sync, so a busy vault does not double-sync", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, PERIODIC, timers);
    s.armPeriodic();
    timers.advance(800_000);
    s.noteSyncStarted(); // something else synced — the idle clock restarts
    timers.advance(800_000);
    expect(fired).toBe(0);
    timers.advance(100_000);
    expect(fired).toBe(1);
  });

  it("can be turned off", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, { ...OPTS, periodicMs: 0 }, timers);
    s.armPeriodic();
    timers.advance(24 * 60 * 60 * 1000);
    expect(fired).toBe(0);
  });

  it("stops on dispose", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, PERIODIC, timers);
    s.armPeriodic();
    s.dispose();
    timers.advance(24 * 60 * 60 * 1000);
    expect(fired).toBe(0);
  });
});

describe("setOptions keeps what is pending (ADR-0072)", () => {
  it("an edit waiting on its debounce still fires, on the new debounce", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, OPTS, timers);
    s.noteChange();
    timers.advance(5_000);
    s.setOptions({ ...OPTS, debounceMs: 3_000 });
    timers.advance(2_999);
    expect(fired).toBe(0);
    timers.advance(1);
    expect(fired).toBe(1);
  });

  it("nothing pending: retiming starts nothing", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, OPTS, timers);
    s.setOptions({ ...OPTS, debounceMs: 1_000 });
    timers.advance(600_000);
    expect(fired).toBe(0);
  });

  it("the minimum interval still counts from the last sync", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, OPTS, timers);
    s.noteSyncStarted(); // a sync at t=0
    s.setOptions({ ...OPTS, debounceMs: 1_000 });
    s.noteChange();
    timers.advance(29_999);
    expect(fired).toBe(0); // the guard remembers t=0
    timers.advance(1);
    expect(fired).toBe(1);
  });

  it("periodic pull: a new period re-arms, zero stops it", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, { ...OPTS, periodicMs: 600_000 }, timers);
    s.armPeriodic();
    s.setOptions({ ...OPTS, periodicMs: 60_000 });
    timers.advance(60_000);
    expect(fired).toBe(1);
    s.noteSyncStarted(); // the sync it triggered re-arms the period...
    s.setOptions({ ...OPTS, periodicMs: 0 }); // ...and zero takes it back
    timers.advance(10_000_000);
    expect(fired).toBe(1);
  });

  it("a disposed scheduler stays disposed", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, { ...OPTS, periodicMs: 60_000 }, timers);
    s.dispose();
    s.setOptions({ ...OPTS, periodicMs: 60_000 });
    timers.advance(600_000);
    expect(fired).toBe(0);
  });
});

describe("the periodic pull respects the minimum interval (ADR-0076)", () => {
  it("a 5 s period under a 120 s minimum pulls at most once per 120 s", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const opts = { ...OPTS, periodicMs: 5_000, minIntervalMs: 120_000 };
    const s = new AutoSyncScheduler(
      () => {
        fired++;
        s.noteSyncStarted(); // what the plugin does when the trigger runs a sync
      },
      opts,
      timers,
    );
    s.armPeriodic();
    timers.advance(119_999);
    expect(fired).toBe(0);
    timers.advance(1);
    expect(fired).toBe(1);
    timers.advance(120_000);
    expect(fired).toBe(2);
  });

  it("a period longer than the minimum is unchanged", () => {
    const timers = new FakeTimers();
    let fired = 0;
    const s = new AutoSyncScheduler(() => fired++, { ...OPTS, periodicMs: 600_000 }, timers);
    s.armPeriodic();
    timers.advance(599_999);
    expect(fired).toBe(0);
    timers.advance(1);
    expect(fired).toBe(1);
  });
});

