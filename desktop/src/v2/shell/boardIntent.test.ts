import { describe, expect, it, vi } from "vitest";
import { openBoardCard, takeBoardCard, watchBoardCard } from "./boardIntent";

describe("boardIntent", () => {
  it("wakes a watcher of that project only, until it stops, and fires once", () => {
    const wake = vi.fn();
    const stop = watchBoardCard("watched", wake);
    openBoardCard("other", 1);
    expect(wake).not.toHaveBeenCalled();
    openBoardCard("watched", 3);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(takeBoardCard("watched")).toBe(3);
    expect(takeBoardCard("watched")).toBeNull();
    stop();
    openBoardCard("watched", 4);
    expect(wake).toHaveBeenCalledTimes(1);
    takeBoardCard("watched");
    takeBoardCard("other");
  });

  it("a take with nothing waiting is null", () => {
    expect(takeBoardCard("nowhere")).toBeNull();
  });
});
