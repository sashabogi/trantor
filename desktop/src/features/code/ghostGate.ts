// The ghost-text debounce + cancel core (#5897), PURE on purpose so the timing rules are
// unit-tested without Monaco or Tauri.
//
// Two problems the naive provider had:
//   1. every keystroke fired a request (after a debounce the OLD code only cleared the timer but
//      never cancelled an already-in-flight request — a slow answer could land AFTER a newer
//      keystroke and overwrite the correct ghost with a stale one);
//   2. the debounce was owned by a module-level timer shared across editors.
//
// This is a small "latest-wins" gate: schedule() debounces, and the moment a newer keystroke
// arrives it invalidates whatever is pending OR already in flight. The caller resolves its item
// list to [] when the gate reports superseded, so Monaco never paints a stale ghost. Every promise
// settles — a superseded one with null, never a hang.
export type GhostRequest = {
  prefix: string;
  suffix: string;
  path: string;
};

export type GhostFetcher = (req: GhostRequest, signal: AbortSignal) => Promise<string | null>;

export type GhostGate = {
  /** Debounce a request; resolves to the completion only if no newer keystroke invalidated it,
   *  else null. The in-flight fetch is aborted via the signal the moment a newer call arrives. */
  schedule(req: GhostRequest): Promise<string | null>;
};

/** One gate per provider registration, so two editors never share a debounce or a fetch. */
export function createGhostGate(debounceMs: number, fetcher: GhostFetcher): GhostGate {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  let epoch = 0;
  // The debounced-but-not-yet-fired promises, each tagged with its epoch. A newer keystroke
  // settles every earlier one with null so no Monaco request is left hanging.
  let waits: Array<{ my: number; resolve: (v: string | null) => void }> = [];
  const settleWaits = (v: string | null) => { for (const w of waits) w.resolve(v); waits = []; };

  return {
    schedule(req) {
      const my = ++epoch;
      if (timer) { clearTimeout(timer); timer = null; }
      // Supersede everything earlier: pending debounces resolve null, and an in-flight fetch is
      // aborted — its answer is stale by definition.
      settleWaits(null);
      if (inflight) { inflight.abort(); inflight = null; }
      return new Promise<string | null>((resolve) => {
        waits.push({ my, resolve });
        timer = setTimeout(() => {
          timer = null;
          if (my !== epoch) return;      // already settled by a newer schedule
          // Only this request survives the wait window; run its fetch.
          waits = [];
          const ctl = new AbortController();
          inflight = ctl;
          fetcher(req, ctl.signal)
            .then((completion) => {
              if (inflight === ctl) inflight = null;
              resolve(my === epoch ? completion : null);
            })
            .catch(() => {
              if (inflight === ctl) inflight = null;
              resolve(null);
            });
        }, debounceMs);
      });
    },
  };
}
