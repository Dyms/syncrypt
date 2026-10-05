// Debounced while-active auto-sync with resource-aware guards (RFC-0004
// §Triggers): wait for edits to settle (debounce), coalesce bursts, and never
// auto-sync more often than the minimum interval. Manual "Sync now" bypasses
// the guards (the caller just invokes the trigger directly and reports back
// via noteSyncStarted). Pure logic — timers and clock injected for tests.

export interface SchedulerOptions {
  debounceMs: number; // default desktop: 15 000
  minIntervalMs: number; // default desktop: 30 000
  /**
   * How long to wait before trying again when the trigger was DECLINED —
   * offline, on cellular under a Wi-Fi-only policy, or a sync already running.
   * Without this the change was simply dropped: the scheduler is re-armed only
   * by a vault edit, so a phone that went quiet on cellular never synced those
   * edits at all, however long it later sat on Wi-Fi (ADR-0047).
   */
  retryMs: number; // default: 60 000
  /**
   * Pull even when nothing changed here, so an open window eventually sees
   * another device's work (RFC-0004 §Triggers promised this and it was never
   * implemented). 0 disables it.
   */
  periodicMs: number; // default desktop: 900 000 (15 min)
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
  private periodic: TimerId | null = null;
  private lastSyncAt = -Infinity;
  private disposed = false;

  constructor(
    private readonly trigger: () => void,
    private opts: SchedulerOptions,
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
    this.armPeriodic();
  }

  /**
   * The trigger fired and the client declined it. Come back — do NOT touch
   * `lastSyncAt`, because no sync started and the interval guard must not be
   * reset by something that did not happen.
   */
  retryLater(): void {
    if (this.disposed) return;
    this.schedule(this.opts.retryMs);
  }

  /** Start the idle pull timer; also called after every sync. */
  armPeriodic(): void {
    if (this.disposed || this.opts.periodicMs <= 0) return;
    if (this.periodic !== null) this.host.clear(this.periodic);
    // Never sooner than the minimum interval allows: RFC-0004 says "at most
    // one auto-sync every M seconds", and a periodic pull is an auto-sync. A
    // 5 s period under a 120 s minimum (the phone default) used to pull 24
    // times in two minutes (audit №4, A7; ADR-0076). Re-armed at every sync
    // start, so the minimum counts from the last sync, as the debounce's does.
    this.periodic = this.host.set(() => {
      this.periodic = null;
      this.trigger();
    }, Math.max(this.opts.periodicMs, this.opts.minIntervalMs));
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

  /**
   * New timings, keeping what is pending (ADR-0072). Settings used to dispose
   * the scheduler and build another on every keystroke in a timing field: an
   * edit waiting on its debounce was dropped and the interval guard forgot the
   * last sync — the "edit waits for an unrelated one" ADR-0047 had fixed.
   */
  setOptions(opts: SchedulerOptions): void {
    if (this.disposed) return;
    this.opts = opts;
    if (this.timer !== null) this.schedule(opts.debounceMs);
    if (opts.periodicMs <= 0) {
      if (this.periodic !== null) this.host.clear(this.periodic);
      this.periodic = null;
    } else {
      this.armPeriodic();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.host.clear(this.timer);
    this.timer = null;
    if (this.periodic !== null) this.host.clear(this.periodic);
    this.periodic = null;
  }
}
