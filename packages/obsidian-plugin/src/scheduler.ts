// Debounced while-active auto-sync with resource-aware guards (RFC-0004
// §Triggers): wait for edits to settle (debounce), coalesce bursts, and never
// auto-sync more often than the minimum interval. Manual "Sync now" bypasses
// the guards (the caller just invokes the trigger directly and reports back
// via noteSyncStarted). Pure logic — timers and clock injected for tests.

export interface SchedulerOptions {
  debounceMs: number; // default desktop: 15 000
  minIntervalMs: number; // default desktop: 30 000
}

type TimerId = ReturnType<typeof setTimeout>;

export interface TimerHost {
  set(fn: () => void, ms: number): TimerId;
  clear(id: TimerId): void;
  now(): number; // milliseconds
}

const defaultHost: TimerHost = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => {
    clearTimeout(id);
  },
  now: () => Date.now(),
};

export class AutoSyncScheduler {
  private timer: TimerId | null = null;
  private lastSyncAt = -Infinity;
  private disposed = false;

  constructor(
    private readonly trigger: () => void,
    private readonly opts: SchedulerOptions,
    private readonly host: TimerHost = defaultHost,
  ) {}

  /** Call on every vault modification event. */
  noteChange(): void {
    if (this.disposed) return;
    this.schedule(this.opts.debounceMs);
  }

  /** Call whenever ANY sync starts (auto or manual) — resets the interval guard. */
  noteSyncStarted(): void {
    this.lastSyncAt = this.host.now();
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) this.host.clear(this.timer); // coalesce bursts
    this.timer = this.host.set(() => {
      this.timer = null;
      const sinceLast = this.host.now() - this.lastSyncAt;
      if (sinceLast < this.opts.minIntervalMs) {
        // Too soon — re-arm for the remainder instead of dropping the change.
        this.schedule(this.opts.minIntervalMs - sinceLast);
        return;
      }
      this.trigger();
    }, delayMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.host.clear(this.timer);
    this.timer = null;
  }
}
