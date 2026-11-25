import { describe, expect, it, vi } from "vitest";
import { setOpenIntent, takeOpenIntent, watchOpenIntent } from "./openIntent";

describe("watchOpenIntent", () => {
  it("wakes a watcher of that project only, until it stops", () => {
    const wake = vi.fn();
    const stop = watchOpenIntent("watched", wake);
    setOpenIntent("other", { kind: "file", path: "a.ts" });
    expect(wake).not.toHaveBeenCalled();
    setOpenIntent("watched", { kind: "file", path: "b.ts" });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(takeOpenIntent("watched")).toEqual({ kind: "file", path: "b.ts" });
    stop();
    setOpenIntent("watched", { kind: "file", path: "c.ts" });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(takeOpenIntent("watched")?.kind).toBe("file");
    takeOpenIntent("other");
  });
});
