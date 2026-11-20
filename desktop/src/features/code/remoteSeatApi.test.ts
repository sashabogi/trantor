// #13938 — the remote seat rows: committed-vs-base counts union uncommitted status, untracked
// carries null counts, and nothing here can turn a failure into an empty list. Pure logic; the
// Rust side owns the ssh leg and prefixes "unreachable:" for transport failures.
import { describe, expect, it } from "vitest";
import { errorLine, isRemoteClean, isUnreachable, remoteChangeRows, type RemoteSeatSnapshot } from "./remoteSeatApi";

const snap = (over: Partial<RemoteSeatSnapshot>): RemoteSeatSnapshot => ({
  machine: "netcup",
  branch: "seat/kimi-9",
  upstream: null,
  ahead: null,
  behind: null,
  base: "deadbee",
  status: [],
  counts: [],
  committed: [],
  log: [],
  ...over,
});

describe("remoteChangeRows", () => {
  it("unions committed-vs-base rows with live status, counts from base", () => {
    const rows = remoteChangeRows(snap({
      committed: [{ path: "a.ts", plus: 7, minus: 3 }, { path: "b.ts", plus: 1, minus: 0 }],
      status: [{ path: "a.ts", x: "M", y: " " }, { path: "c.ts", x: " ", y: "M" }],
      counts: [{ path: "c.ts", plus: 2, minus: 1 }],
    }));
    expect(rows).toEqual([
      { path: "a.ts", status: "M", plus: 7, minus: 3, untracked: false, uncommitted: true },
      { path: "b.ts", status: "M", plus: 1, minus: 0, untracked: false, uncommitted: false },
      { path: "c.ts", status: "M", plus: 2, minus: 1, untracked: false, uncommitted: true },
    ]);
  });

  it("an untracked file has no counts — git measured nothing, null beats a fake zero", () => {
    const rows = remoteChangeRows(snap({
      status: [{ path: "brand-new.ts", x: "?", y: "?" }],
    }));
    expect(rows).toEqual([
      { path: "brand-new.ts", status: "??", plus: null, minus: null, untracked: true, uncommitted: true },
    ]);
  });

  it("committed work alone still reads as changed — a clean worktree is not a landed branch", () => {
    const rows = remoteChangeRows(snap({
      committed: [{ path: "landed.ts", plus: 4, minus: 2 }],
    }));
    expect(rows.length).toBe(1);
    expect(rows[0].uncommitted).toBe(false);
    expect(isRemoteClean(snap({ committed: [{ path: "landed.ts", plus: 4, minus: 2 }] }))).toBe(false);
  });
});

describe("isRemoteClean", () => {
  it("only an empty union is clean", () => {
    expect(isRemoteClean(snap({}))).toBe(true);
    expect(isRemoteClean(snap({ status: [{ path: "x", x: "?", y: "?" }] }))).toBe(false);
  });
});

describe("unreachable is a named state, never an empty answer", () => {
  it("matches the Rust prefix and surfaces the first line only", () => {
    expect(isUnreachable("unreachable: ssh: connect to host netcup port 22: Operation timed out")).toBe(true);
    expect(isUnreachable("no machines.netcup.ssh in config.json")).toBe(false);
    expect(errorLine("unreachable: ssh: connect timed out\nsecond line")).toBe("unreachable: ssh: connect timed out");
    expect(errorLine("Error: boom")).toBe("Error: boom");
  });
});
