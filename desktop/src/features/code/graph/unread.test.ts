// The unit drill for #7977 (blueprint §5 card 7): the four-row table over Flare's rule, then the
// tally the Home stat shows across projects.
import { describe, expect, it } from "vitest";
import { unreadCount, unreadLabel, unreadMarks, unreadState, unreadTally, type FileEvent } from "./unread";

const t0 = 1_000;
const t1 = 2_000;
const t2 = 3_000;

const claim = (file: string, ts: number, project = "p"): FileEvent => ({ type: "file.claim", ts, file, project });
const read = (file: string, ts: number, project = "p"): FileEvent => ({ type: "file.read", ts, file, project });

describe("unreadState · the four-row table", () => {
  it.each([
    ["no changes -> nothing unread on a fresh repo", 0, 0, "unchanged"],
    ["claim at t1, no read -> unread", t1, 0, "unread"],
    ["claim at t1, read at t2 > t1 -> read", t1, t2, "read"],
    ["read at t0 then claim at t1 -> unread again", t1, t0, "unread"],
  ] as const)("%s", (_row, changedAt, readAt, expected) => {
    expect(unreadState(changedAt, readAt)).toBe(expected);
  });
});

describe("unreadMarks · the same table over the log's events", () => {
  it("a fresh repo with no events has no marks, so nothing is unread", () => {
    const marks = unreadMarks([]);
    expect(marks.size).toBe(0);
    expect(unreadCount(marks)).toBe(0);
  });

  it("claim at t1 with no read is unread", () => {
    expect(unreadMarks([claim("lib/a.ts", t1)]).get("lib/a.ts")).toBe("unread");
  });

  it("claim at t1 then read at t2 is read", () => {
    expect(unreadMarks([claim("lib/a.ts", t1), read("lib/a.ts", t2)]).get("lib/a.ts")).toBe("read");
  });

  it("read at t0 then claim at t1 is unread again", () => {
    expect(unreadMarks([read("lib/a.ts", t0), claim("lib/a.ts", t1)]).get("lib/a.ts")).toBe("unread");
  });

  it("a watcher stamp counts as a change like a claim does, and the newest wins", () => {
    const marks = unreadMarks([read("lib/a.ts", t1)], [{ path: "lib/a.ts", ts: t2 }]);
    expect(marks.get("lib/a.ts")).toBe("unread");
    expect(unreadMarks([read("lib/a.ts", t2)], [{ path: "lib/a.ts", ts: t1 }]).get("lib/a.ts")).toBe("read");
  });

  it("a read of one file says nothing about another", () => {
    const marks = unreadMarks([claim("lib/a.ts", t1), claim("lib/b.ts", t1), read("lib/a.ts", t2)]);
    expect(marks.get("lib/a.ts")).toBe("read");
    expect(marks.get("lib/b.ts")).toBe("unread");
    expect(unreadCount(marks)).toBe(1);
  });

  it("events without a file are ignored", () => {
    expect(unreadMarks([{ type: "file.claim", ts: t1 }]).size).toBe(0);
  });
});

describe("unreadTally · the Home stat across projects", () => {
  it("counts unread files per project and the projects that carry any", () => {
    const events = [
      claim("lib/a.ts", t1, "alpha"),
      claim("lib/b.ts", t1, "alpha"),
      claim("lib/a.ts", t1, "beta"),
      read("lib/a.ts", t2, "beta"),
      claim("x.ts", t1, "gamma"),
    ];
    expect(unreadTally(events)).toEqual({ files: 3, projects: 2 });
    expect(unreadLabel(unreadTally(events))).toBe("3 files across 2 projects");
  });

  it("the same path in two projects is two files, and a read in one clears only that one", () => {
    const before = unreadTally([claim("lib/a.ts", t1, "alpha"), claim("lib/a.ts", t1, "beta")]);
    expect(before).toEqual({ files: 2, projects: 2 });
    const after = unreadTally([claim("lib/a.ts", t1, "alpha"), claim("lib/a.ts", t1, "beta"), read("lib/a.ts", t2, "alpha")]);
    expect(after).toEqual({ files: 1, projects: 1 });
  });

  it("nothing unread reads as the calm zero", () => {
    expect(unreadLabel(unreadTally([]))).toBe("nothing unread");
    expect(unreadLabel({ files: 1, projects: 1 })).toBe("1 file across 1 project");
  });
});
