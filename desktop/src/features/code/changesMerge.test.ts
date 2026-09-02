// The merge/roll-up contract for the multi-seat change map (#5959): a path's union entry carries
// every seat that touched it (checkout = null), counts SUM only when every contributor measured
// them, and folders roll their subtree's seats up.
import { describe, expect, it } from "vitest";
import { folderSeats, mergeChanges, mergedCountFor } from "./gitApi";

const row = (seat: string | null, path: string, status: string, plus: number | null = null, minus: number | null = null) =>
  ({ seat, path, status, plus, minus });

describe("mergeChanges", () => {
  it("unions seats per path and sums measured counts", () => {
    const merged = mergeChanges([
      row("glm", "src/app.ts", "M", 10, 2),
      row("codex", "src/app.ts", "M", 5, 1),
      row(null, "src/app.ts", "M", 3, 0),
    ]);
    expect(merged).toEqual([
      { path: "src/app.ts", seats: ["glm", "codex", null], status: "M", plus: 18, minus: 3 },
    ]);
  });

  it("counts go null the moment one seat could not measure", () => {
    const merged = mergeChanges([
      row("glm", "new.ts", "??", 4, null),
      row("codex", "new.ts", "??", null, 2),
    ]);
    expect(merged[0].plus).toBeNull();
    expect(merged[0].minus).toBeNull();
  });

  it("keeps distinct paths distinct, in first-seen order", () => {
    const merged = mergeChanges([row("glm", "b.ts", "??"), row("glm", "a.ts", "M", 1, 0)]);
    expect(merged.map(e => e.path)).toEqual(["b.ts", "a.ts"]);
  });

  it("the checkout's row keeps seat null", () => {
    const merged = mergeChanges([row(null, "f.txt", "M", 1, 1)]);
    expect(merged[0].seats).toEqual([null]);
  });
});

describe("folderSeats", () => {
  it("rolls subtree seats up to every ancestor folder", () => {
    const seatsByFolder = folderSeats([
      { path: "desktop/src/features/x.ts", seats: ["glm", "codex"], status: "M", plus: 1, minus: 0 },
      { path: "desktop/src/shared/y.ts", seats: [null], status: "M", plus: 0, minus: 2 },
    ]);
    expect(seatsByFolder["desktop"]).toEqual(["glm", "codex", null]);
    expect(seatsByFolder["desktop/src"]).toEqual(["glm", "codex", null]);
    expect(seatsByFolder["desktop/src/features"]).toEqual(["glm", "codex"]);
    expect(seatsByFolder["desktop/src/shared"]).toEqual([null]);
  });

  it("the file row itself is not a folder", () => {
    const seatsByFolder = folderSeats([{ path: "README.md", seats: ["glm"], status: "M", plus: 1, minus: 0 }]);
    expect(Object.keys(seatsByFolder)).toEqual([]);
  });
});

describe("mergedCountFor", () => {
  it("reads the union entry, null when unmeasured or absent", () => {
    const entries = mergeChanges([row("glm", "a.ts", "M", 2, 1), row(null, "new.ts", "??")]);
    expect(mergedCountFor(entries, "a.ts")).toEqual({ plus: 2, minus: 1 });
    expect(mergedCountFor(entries, "new.ts")).toBeNull();
    expect(mergedCountFor(entries, "nope.ts")).toBeNull();
  });
});
