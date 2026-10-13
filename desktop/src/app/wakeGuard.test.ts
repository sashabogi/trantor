import { describe, expect, it } from "vitest";
import { guardedWake } from "./wakeGuard";

// #11640: the guard is per project.
describe("guardedWake", () => {
  it("runs two projects at once and ignores a repeat of one that is running", async () => {
    const inflight = new Set<string>();
    const release: Record<string, () => void> = {};
    const started: string[] = [];
    const run = (p: string) => () => new Promise<void>(res => { started.push(p); release[p] = res; });
    const a = guardedWake(inflight, "a", run("a"));
    const b = guardedWake(inflight, "b", run("b"));
    expect(await guardedWake(inflight, "a", run("a-again"))).toBe(false);
    expect(started).toEqual(["a", "b"]);
    release.a();
    release.b();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(inflight.size).toBe(0);
  });

  it("releases the slot when the run throws", async () => {
    const inflight = new Set<string>();
    await expect(guardedWake(inflight, "a", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(inflight.has("a")).toBe(false);
    expect(await guardedWake(inflight, "a", async () => {})).toBe(true);
  });
});
