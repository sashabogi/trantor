import { describe, expect, it, vi } from "vitest";
import { clearGraphBack, currentGraphBack, setGraphBack, watchGraphBack } from "./graphBack";

describe("graphBack", () => {
  it("wakes a watcher on set and on clear, until it stops", () => {
    const wake = vi.fn();
    const stop = watchGraphBack(wake);
    setGraphBack({ project: "p", path: "src/a.ts" });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(currentGraphBack()).toEqual({ project: "p", path: "src/a.ts" });
    clearGraphBack();
    expect(wake).toHaveBeenCalledTimes(2);
    expect(currentGraphBack()).toBeNull();
    stop();
    setGraphBack({ project: "p", path: "src/b.ts" });
    expect(wake).toHaveBeenCalledTimes(2);
    clearGraphBack();
  });

  it("clearing with no origin wakes nobody", () => {
    const wake = vi.fn();
    watchGraphBack(wake);
    clearGraphBack();
    expect(wake).not.toHaveBeenCalled();
    expect(currentGraphBack()).toBeNull();
    clearGraphBack();
  });
});
