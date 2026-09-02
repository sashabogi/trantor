// #5897 — the ghost-text timing rules, pinned as a pure module. Debounce means a burst of
// keystrokes coalesces into ONE fetch; cancel means a keystroke that lands while a fetch is in
// flight invalidates that fetch (its answer must never paint a stale ghost).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGhostGate, splitPrefix, type GhostFetcher, type GhostRequest } from "./ghostGate";

const REQ: GhostRequest = { prefix: "fn", suffix: "}", path: "a.ts" };

describe("createGhostGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it("debounces: rapid keystrokes run ONE fetch, after the debounce window", async () => {
    const fetcher: GhostFetcher = vi.fn().mockResolvedValue("the completion");
    const gate = createGhostGate(250, fetcher);

    const p1 = gate.schedule(REQ);
    const p2 = gate.schedule(REQ);
    const p3 = gate.schedule(REQ);
    await advance(100);           // inside the window — nothing should have fired yet
    expect(fetcher).not.toHaveBeenCalled();
    await advance(250);           // window elapses after the LAST keystroke
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(p1).resolves.toBeNull();   // superseded — but still settled, never hung
    await expect(p2).resolves.toBeNull();
    await expect(p3).resolves.toBe("the completion");
  });

  it("a keystroke during an in-flight fetch aborts it and discards its answer", async () => {
    const resolvers: Array<(v: string | null) => void> = [];
    const aborts: boolean[] = [];
    const fetcher: GhostFetcher = (_req, signal) => new Promise((resolve) => {
      resolvers.push(resolve);
      signal.addEventListener("abort", () => { aborts.push(true); resolve(null); });
    });
    const gate = createGhostGate(250, fetcher);

    const p1 = gate.schedule(REQ);
    await advance(250);           // first fetch is now in flight
    expect(resolvers.length).toBe(1);
    const p2 = gate.schedule(REQ);   // keystroke while fetch 1 runs
    await advance(250);              // second fetch starts
    expect(resolvers.length).toBe(2);
    expect(aborts.length).toBe(1);   // fetch 1 was told to stop

    // Fetch 1's late answer must not win.
    resolvers[0]!("stale");
    await expect(p1).resolves.toBeNull();
    resolvers[1]!("fresh");
    await expect(p2).resolves.toBe("fresh");
  });

  it("a completed fetch resolves its ghost unless a newer keystroke landed first", async () => {
    const calls: Array<[string, string]> = [];
    const fetcher: GhostFetcher = async (req) => {
      calls.push([req.prefix, req.suffix]);
      return `done:${req.prefix}`;
    };
    const gate = createGhostGate(250, fetcher);

    const p1 = gate.schedule({ ...REQ, prefix: "a" });
    await advance(300);            // first fetch completes normally
    await expect(p1).resolves.toBe("done:a");
    expect(calls).toEqual([["a", "}"]]);
  });

  it("a fetch error resolves to null (no ghost), never rejects", async () => {
    const fetcher: GhostFetcher = () => Promise.reject(new Error("network"));
    const gate = createGhostGate(250, fetcher);
    const p = gate.schedule(REQ);
    await advance(300);
    await expect(p).resolves.toBeNull();
  });
});

describe("splitPrefix (#6160 cached-input tier)", () => {
  it("puts the last 8 lines in near and everything above in head", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line${i}`);
    const { head, near } = splitPrefix(lines.join("\n"));
    expect(head).toBe("line0\nline1\nline2\nline3");
    expect(near).toBe("line4\nline5\nline6\nline7\nline8\nline9\nline10\nline11");
  });

  it("a short prefix is ALL near — nothing is stable yet", () => {
    const prefix = "a\nb\nc";
    const { head, near } = splitPrefix(prefix);
    expect(head).toBe("");
    expect(near).toBe(prefix);
  });

  it("an exactly-8-line prefix is all near with an empty head", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `l${i}`);
    const prefix = lines.join("\n");
    const { head, near } = splitPrefix(prefix);
    expect(head).toBe("");
    expect(near).toBe(prefix);
  });

  it("head + near reassemble byte-identical to the original prefix", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `const r${i} = ${i};`);
    const prefix = lines.join("\n");
    const { head, near } = splitPrefix(prefix);
    expect(head).not.toBe("");
    expect(`${head}\n${near}`).toBe(prefix);
  });
});
