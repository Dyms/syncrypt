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

const OPTS = { debounceMs: 15_000, minIntervalMs: 30_000 };

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
