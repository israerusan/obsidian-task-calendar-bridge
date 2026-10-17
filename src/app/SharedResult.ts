/**
 * One expensive result, computed at most once at a time and shared by everyone who asks.
 *
 * The calendar preview walks the whole vault and builds the whole calendar. Every open calendar
 * view, the explain command, and every refresh after a vault event used to start that walk on
 * its own, so an edit during a slow refresh on a large vault started a second full walk while
 * the first was still running, and its result was then thrown away.
 *
 * The rules:
 *   - `invalidate()` says the inputs changed. It never starts work.
 *   - `get()` returns a result computed AFTER the most recent `invalidate()` before the call —
 *     never an older one, which would show an edit as not having happened.
 *   - At most one computation runs. A `get()` that arrives while an out-of-date one is running
 *     waits for it to finish and then starts exactly one fresh computation, which every caller
 *     that arrived in the meantime shares.
 *   - A failure is not cached: the next `get()` tries again.
 */
export class SharedResult<T> {
  private version = 0;
  private cached: { version: number; value: T } | null = null;
  private running: { version: number; promise: Promise<T> } | null = null;

  constructor(private readonly compute: () => Promise<T>) {}

  invalidate(): void {
    this.version++;
  }

  /** Drops everything, for when the owner is going away. */
  clear(): void {
    this.version++;
    this.cached = null;
  }

  get(): Promise<T> {
    const wanted = this.version;
    if (this.cached && this.cached.version === wanted) return Promise.resolve(this.cached.value);
    if (this.running) {
      if (this.running.version === wanted) return this.running.promise;
      // Out of date: let it finish rather than racing it, then ask again. Every caller in this
      // branch lands on the same fresh run, because the first one to get there starts it.
      return this.running.promise.then(
        () => this.get(),
        () => this.get()
      );
    }
    return this.start(wanted);
  }

  private start(version: number): Promise<T> {
    const promise = this.compute().then(
      (value) => {
        if (this.running?.promise === promise) this.running = null;
        // Only cached when nothing invalidated it while it ran; otherwise it is still a correct
        // answer for the callers who asked before that, but not for anyone after.
        if (version === this.version) this.cached = { version, value };
        return value;
      },
      (error: unknown) => {
        if (this.running?.promise === promise) this.running = null;
        throw error;
      }
    );
    this.running = { version, promise };
    return promise;
  }
}
