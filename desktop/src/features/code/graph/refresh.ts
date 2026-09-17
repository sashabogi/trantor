// Refresh for the graph view (#7953, blueprint §2 "Refresh, in this order"): the watcher's
// `file-changed` batches (200ms) collapse to one `code_graph` rebuild per quiet second, and a
// rebuild never overlaps another. Pure so the timing is pinned by a test, not by a hand.

/** How long the tree must stay quiet before a rebuild fires. */
export const QUIET_MS = 1000;

/** graft's own output lives under `graft/` in the checkout, which the watcher does not skip:
 *  a rebuild that heard its own writes would rebuild forever. */
export function isBuildOutput(path: string): boolean {
  const first = path.replace(/^[/\\]+/, "").split(/[/\\]/, 1)[0];
  return first === "graft";
}

/** Whether a watcher batch holds anything a rebuild would see differently. */
export function rebuildWorthy(paths: readonly string[]): boolean {
  return paths.some(p => p.length > 0 && !isBuildOutput(p));
}

export type TimerHandle = ReturnType<typeof setTimeout>;

/** The clock, injectable so a test can count the calls. */
export type Timers = {
  set: (fn: () => void, ms: number) => TimerHandle;
  clear: (handle: TimerHandle) => void;
};

const REAL_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle),
};

export type QuietRebuild = {
  /** A batch arrived: (re)arm the quiet timer, or remember it if a build is running. */
  touch: () => void;
  /** Drop the armed timer; a build already running is left to finish. */
  cancel: () => void;
  /** Whether a timer is armed (for tests and the header chip). */
  readonly armed: boolean;
  /** Whether a build is running right now. */
  readonly building: boolean;
};

/** Trailing debounce with an in-flight guard: `build` runs once `quietMs` after the last touch;
 *  touches during a build re-arm the timer when it ends, so two graft builds never share a cache. */
export function quietRebuild(build: () => Promise<void>, quietMs = QUIET_MS, timers: Timers = REAL_TIMERS): QuietRebuild {
  let handle: TimerHandle | null = null;
  let building = false;
  let touchedWhileBuilding = false;

  const arm = () => {
    if (handle !== null) timers.clear(handle);
    handle = timers.set(run, quietMs);
  };

  const run = () => {
    handle = null;
    building = true;
    touchedWhileBuilding = false;
    build()
      .catch(() => undefined)
      .then(() => {
        building = false;
        if (touchedWhileBuilding) arm();
      });
  };

  return {
    touch() {
      if (building) {
        touchedWhileBuilding = true;
        return;
      }
      arm();
    },
    cancel() {
      if (handle !== null) timers.clear(handle);
      handle = null;
      touchedWhileBuilding = false;
    },
    get armed() { return handle !== null; },
    get building() { return building; },
  };
}
