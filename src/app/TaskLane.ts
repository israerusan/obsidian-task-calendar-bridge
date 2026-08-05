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
  /**
   * Where a failed *scheduled* run goes.
   *
   * Nobody is awaiting one, so without this its rejection has no handler at all — the failure
   * becomes an unhandled promise rejection the user never sees. That matters most for the
   * settings lane: every text field in the settings tab saves through `schedule()`, and a write
   * that fails because the vault is in a cloud folder would otherwise revert the setting
   * silently at the next restart.
   */
  onError?: (error: unknown) => void;
}

export class TaskLane {
  private readonly delayMs: number;
  private readonly run: () => Promise<void>;
  private readonly timer: Timer;
  private readonly alive: () => boolean;
  private readonly onError: (error: unknown) => void;

  /** Kept on a settled branch so one failure cannot poison every later run. */
  private chain: Promise<unknown> = Promise.resolve();
  private handle: unknown = undefined;
  private pending = false;
  /**
   * Bumped by `cancel()`. A scheduled run that has been handed to the chain but has not started
   * carries the epoch it was created under, so cancelling drops it too — otherwise `cancel()`
   * only meant "stop the timer", and a queued run went ahead anyway.
   */
  private epoch = 0;

  constructor(options: TaskLaneOptions) {
    this.delayMs = options.delayMs;
    this.run = options.run;
    this.timer = options.timer;
    this.alive = options.alive ?? ((): boolean => true);
    this.onError = options.onError ?? ((): void => undefined);
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
    const epoch = this.epoch;
    this.handle = this.timer.set(() => {
      this.handle = undefined;
      if (this.pending) return;
      this.pending = true;
      // Nobody awaits this, so its failure needs somewhere to go or it becomes an unhandled
      // rejection and the user is told nothing at all.
      this.enqueue(() => {
        // Released as the run STARTS, not when it ends. An edit made while this run is under
        // way is not reflected in it, and must be able to schedule the next one.
        this.pending = false;
        if (epoch !== this.epoch || !this.alive()) return Promise.resolve();
        return this.run();
      }).catch((error) => this.onError(error));
    }, this.delayMs);
  }

  /** Put an arbitrary task in the same order as the runs. */
  async enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task);
    this.chain = next.catch(() => undefined);
    await next;
  }

  /**
   * Drop the scheduled run — whether it is still on the timer or already queued behind other
   * work. Explicit `enqueue()` calls are untouched: someone is awaiting those.
   */
  cancel(): void {
    if (this.handle !== undefined) this.timer.clear(this.handle);
    this.handle = undefined;
    this.pending = false;
    this.epoch++;
  }

  /** Whether a scheduled run is still coming. */
  get isScheduled(): boolean {
    return this.handle !== undefined || this.pending;
  }
}
