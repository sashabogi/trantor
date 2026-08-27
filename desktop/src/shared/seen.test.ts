// "Seen" is a local, human-side ledger: the badge is (direct messages) minus (ids marked read).
// The module keeps its set in module state and persists to localStorage — which does not exist
// under the node environment, and must not need to: the I/O boundary already swallows that.
import { describe, expect, it, vi } from "vitest";

// Each test gets a fresh module instance so the module-level set never leaks between tests.
async function fresh() {
  vi.resetModules();
  return import("./seen");
}

describe("seen", () => {
  it("mark/read round-trip: unseen until marked, seen after", async () => {
    const seen = await fresh();
    expect(seen.hasSeen(1)).toBe(false);
    seen.markSeen(1);
    expect(seen.hasSeen(1)).toBe(true);
  });

  it("countUnseen is the badge math: ids I have not read", async () => {
    const seen = await fresh();
    seen.markSeen(1);
    seen.markSeen(2);
    expect(seen.countUnseen([1, 2, 3])).toBe(1);
    expect(seen.countUnseen([])).toBe(0);
  });

  it("markSeen is idempotent and notifies subscribers exactly once per new id", async () => {
    const seen = await fresh();
    let calls = 0;
    const off = seen.onSeenChange(() => { calls++; });
    seen.markSeen(1);
    seen.markSeen(1);
    expect(calls).toBe(1);
    off();
    seen.markSeen(2);
    expect(calls).toBe(1);
  });

  it("markSeen ignores ids that are not finite numbers", async () => {
    const seen = await fresh();
    seen.markSeen(NaN);
    expect(seen.hasSeen(NaN)).toBe(false);
  });

  it("works with no localStorage at all: the badge degrades, never breaks", async () => {
    // This whole file runs under the node environment, which has no localStorage — the
    // module's I/O boundary must swallow that, and marking still has to work in memory.
    const seen = await fresh();
    expect(() => seen.markSeen(42)).not.toThrow();
    expect(seen.hasSeen(42)).toBe(true);
  });
});
