// The refresh rule (#7953): a burst of watcher batches becomes one rebuild after a quiet second,
// a build in flight defers the next instead of overlapping it, and graft's own output under
// graft/ never counts as a change. Fake timers pin the second; the real one is in the drill.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBuildOutput, QUIET_MS, quietRebuild, rebuildWorthy } from "./refresh";

describe("rebuildWorthy", () => {
  it("drops graft's own output so a build never triggers itself", () => {
    expect(isBuildOutput("graft/.graph/wiring.json")).toBe(true);
    expect(isBuildOutput("graft/.cache/fingerprint.json")).toBe(true);
    expect(isBuildOutput("/graft/.cache/x")).toBe(true);
    expect(isBuildOutput("lib/graft/a.ts")).toBe(false);
    expect(isBuildOutput("graft.ts")).toBe(false);
    expect(rebuildWorthy(["graft/.graph/wiring.json", "graft/.cache/a"])).toBe(false);
  });

  it("counts any source path, even beside build output", () => {
    expect(rebuildWorthy(["graft/.graph/wiring.json", "lib/a.ts"])).toBe(true);
    expect(rebuildWorthy(["lib/x.ts"])).toBe(true);
    expect(rebuildWorthy([])).toBe(false);
    expect(rebuildWorthy([""])).toBe(false);
  });
});

describe("quietRebuild", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

  it("collapses a burst of touches into one build a quiet second after the last", async () => {
    const build = vi.fn(async () => undefined);
    const q = quietRebuild(build);
    q.touch();
    vi.advanceTimersByTime(600);
    q.touch();
    vi.advanceTimersByTime(600);
    q.touch();
    expect(build).not.toHaveBeenCalled();
    expect(q.armed).toBe(true);
    vi.advanceTimersByTime(QUIET_MS - 1);
    expect(build).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(q.armed).toBe(false);
    await settle();
    expect(q.building).toBe(false);
  });

  it("a touch during a build defers a second build until the first ends, never overlapping", async () => {
    let finish: () => void = () => {};
    const build = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const q = quietRebuild(build);
    q.touch();
    vi.advanceTimersByTime(QUIET_MS);
    expect(build).toHaveBeenCalledTimes(1);
    expect(q.building).toBe(true);

    q.touch();
    q.touch();
    vi.advanceTimersByTime(QUIET_MS * 3);
    expect(build, "no second build while the first runs").toHaveBeenCalledTimes(1);
    expect(q.armed).toBe(false);

    finish();
    await settle();
    expect(q.building).toBe(false);
    expect(q.armed, "the deferred touch re-armed the quiet timer").toBe(true);
    vi.advanceTimersByTime(QUIET_MS);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("a build with nothing touched during it does not re-arm", async () => {
    const build = vi.fn(async () => undefined);
    const q = quietRebuild(build);
    q.touch();
    vi.advanceTimersByTime(QUIET_MS);
    await settle();
    expect(q.armed).toBe(false);
    vi.advanceTimersByTime(QUIET_MS * 5);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("a failed build still lets the next one run", async () => {
    const build = vi.fn(async () => { throw new Error("graft build failed"); });
    const q = quietRebuild(build);
    q.touch();
    vi.advanceTimersByTime(QUIET_MS);
    await settle();
    expect(q.building).toBe(false);
    q.touch();
    vi.advanceTimersByTime(QUIET_MS);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("cancel drops the armed timer and forgets a deferred touch", async () => {
    const build = vi.fn(async () => undefined);
    const q = quietRebuild(build);
    q.touch();
    q.cancel();
    expect(q.armed).toBe(false);
    vi.advanceTimersByTime(QUIET_MS * 2);
    expect(build).not.toHaveBeenCalled();
  });

  it("honours an injected quiet window and timer pair", () => {
    const timers = {
      set: vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms)),
      clear: vi.fn((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle)),
    };
    const q = quietRebuild(async () => undefined, 250, timers);
    q.touch();
    q.touch();
    expect(timers.set).toHaveBeenCalledTimes(2);
    expect(timers.set).toHaveBeenLastCalledWith(expect.any(Function), 250);
    expect(timers.clear).toHaveBeenCalledTimes(1);
    expect(timers.clear).toHaveBeenCalledWith(timers.set.mock.results[0]?.value);
  });
});
