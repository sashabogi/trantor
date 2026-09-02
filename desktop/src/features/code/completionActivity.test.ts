import { describe, expect, it, vi } from "vitest";
import { CompletionActivityTracker, formatCompletionActivity, type CompletionResponse } from "./completionActivity";

const URI = "file:///repo/crate/src/lib.rs";

describe("completion activity", () => {
  it("reports asking, then the concrete answer for the matching document", async () => {
    let answer!: (value: CompletionResponse) => void;
    const request = vi.fn(() => new Promise<CompletionResponse>(resolve => { answer = resolve; }));
    const tracker = new CompletionActivityTracker(request, () => 9_700);
    const changes = vi.fn();
    tracker.onChange(changes);

    const pending = tracker.complete(URI, "rust", 5, 10);
    expect(tracker.activityForPath("/repo/crate", "src/lib.rs")).toEqual({
      pending: true,
      answeredAt: null,
      itemCount: null,
    });
    expect(tracker.activityForPath("/other", "src/lib.rs")).toBeNull();

    answer({ items: [{}, {}] });
    await pending;
    expect(tracker.activityForPath("/repo/crate", "src/lib.rs")).toEqual({
      pending: false,
      answeredAt: 9_700,
      itemCount: 2,
    });
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("keeps asking until overlapping requests have both settled", async () => {
    const answers: Array<(value: CompletionResponse) => void> = [];
    const tracker = new CompletionActivityTracker(
      () => new Promise<CompletionResponse>(resolve => { answers.push(resolve); }),
      () => 20_000,
    );
    const first = tracker.complete(URI, "rust", 1, 1);
    const second = tracker.complete(URI, "rust", 1, 2);
    answers[0]([]);
    await first;
    expect(tracker.activityForPath("/repo/crate", "src/lib.rs")?.pending).toBe(true);
    answers[1]({ items: Array.from({ length: 100 }, () => ({})) });
    await second;
    expect(tracker.activityForPath("/repo/crate", "src/lib.rs")?.itemCount).toBe(100);
  });

  it("formats the operator-facing pending and answer states", () => {
    expect(formatCompletionActivity({ pending: true, answeredAt: null, itemCount: null }, 10_000)).toBe("asking…");
    expect(formatCompletionActivity({ pending: false, answeredAt: 9_700, itemCount: 100 }, 10_000))
      .toBe("completion answered 0.3s ago (100 items)");
  });
});
