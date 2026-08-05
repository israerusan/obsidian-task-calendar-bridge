/**
 * One thing happening at a time, with the newest request always winning.
 *
 * Five separate mechanisms used to do this: two Obsidian debouncers, two promise chains, and a
 * boolean. Each was added on its own, in response to a different way the plugin had raced
 * itself, and none of them knew about the others. They are one idea:
 *
 *   - **Serialised.** Runs never overlap. Queuing only the final write was not enough — a slow
 *     export that started first could finish last and put a stale calendar on disk, then
 *     overwrite the newer run's report with it.
 *   - **Coalesced.** While a run is pending, further requests do not stack up. A queue of them
 *     is just work that was stale before it started.
 *   - **Trailing.** A request made *during* a run schedules exactly one more, because the edit
 *     that caused it is not in the run already underway. This is why the pending flag is
 *     released when a run STARTS rather than when it finishes.
 *   - **Cancellable.** A pending run must not fire after the plugin is unloaded, or it writes
 *     into a vault whose plugin instance is gone.
 *
 * The timer is injected so tests can drive it, rather than waiting out a real two seconds.
 */

/**
 * The host's timers, supplied by the caller.
 *
 * Deliberately not defaulted to a bare `setTimeout`: this layer must not touch host globals —
 * that is what keeps it loadable in a test — and Obsidian's own review rules require
 * `window.setTimeout` so a timer keeps working in a popped-out window.
 */
export interface Timer {
  /** Returns a handle the lane can cancel. */
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface TaskLaneOptions {
  /** Quiet period before a scheduled run starts. Each request restarts it. */
  delayMs: number;
  run: () => Promise<void>;
  timer: Timer;
  /** False once the plugin is unloaded; nothing may start or continue after that. */
  alive?: () => boolean;
}

export class TaskLane {
  private readonly delayMs: number;
  private readonly run: () => Promise<void>;
  private readonly timer: Timer;
  private readonly alive: () => boolean;

  /** Kept on a settled branch so one failure cannot poison every later run. */
  private chain: Promise<unknown> = Promise.resolve();
  private handle: unknown = undefined;
  private pending = false;

  constructor(options: TaskLaneOptions) {
    this.delayMs = options.delayMs;
    this.run = options.run;
    this.timer = options.timer;
    this.alive = options.alive ?? ((): boolean => true);
  }

  /**
   * Ask for a run after the quiet period, restarting it on every call.
   *
   * Once a run is already waiting its turn, further calls are dropped: the run has not started
   * yet, so it will see whatever those calls were about.
   */
  schedule(): void {
    if (!this.alive()) return;
    if (this.handle !== undefined) this.timer.clear(this.handle);
    this.handle = this.timer.set(() => {
      this.handle = undefined;
      if (this.pending) return;
      this.pending = true;
      void this.enqueue(() => {
        // Released as the run STARTS, not when it ends. An edit made while this run is under
        // way is not reflected in it, and must be able to schedule the next one.
        this.pending = false;
        return this.alive() ? this.run() : Promise.resolve();
      });
    }, this.delayMs);
  }

  /** Run now, still in order behind anything already queued. */
  async runNow(): Promise<void> {
    await this.enqueue(() => (this.alive() ? this.run() : Promise.resolve()));
  }

  /** Put an arbitrary task in the same order as the runs. */
  async enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    await next;
  }

  /** Drop anything waiting on the timer. Work already in the chain still finishes. */
  cancel(): void {
    if (this.handle !== undefined) this.timer.clear(this.handle);
    this.handle = undefined;
    this.pending = false;
  }

  /** Whether a scheduled run is waiting — for tests and diagnostics. */
  get isScheduled(): boolean {
    return this.handle !== undefined || this.pending;
  }
}
