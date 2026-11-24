// #13988: the pure rules of the Code screen.
import { describe, expect, it } from "vitest";
import { deriveSeat, filterHistory, groupBranches, parseCardRef, parseSearch, sidebarVisible, toRow, type SeatInfo } from "./model";
import { pairHunk, parseUnifiedDiff } from "./diff";
import { countConflicts, parseConflicts, resolveChunks } from "./conflicts";
import { closeTab, openTab } from "./useTabs";
import { SOURCE_TAB } from "./TabBar";

describe("parseCardRef", () => {
  it("reads the first #card in a subject", () => {
    expect(parseCardRef("#13970 Restore opted-in projects")).toBe(13970);
    expect(parseCardRef("fix the bug (#13968) and #13969")).toBe(13968);
  });
  it("ignores short numbers and subjects without a card", () => {
    expect(parseCardRef("release #12")).toBeNull();
    expect(parseCardRef("plain subject")).toBeNull();
  });
});

describe("deriveSeat", () => {
  const ctx = { seats: ["codex-8", "kimi-9"], branch: "main" };
  it("prefers a Seat trailer, then the author, then the seat branch", () => {
    expect(deriveSeat({ author: "sashabogi", subject: "x", trailers: "Seat: glm-5" }, ctx)).toBe("glm-5");
    expect(deriveSeat({ author: "codex-8 (codex)", subject: "x" }, ctx)).toBe("codex-8");
    expect(deriveSeat({ author: "sashabogi", subject: "x" }, { ...ctx, branch: "seat/kimi-9" })).toBe("kimi-9");
  });
  it("answers null for a human on a non-seat branch", () => {
    expect(deriveSeat({ author: "sashabogi", subject: "x" }, ctx)).toBeNull();
  });
});

describe("history search", () => {
  const ctx = { seats: ["codex-8"], branch: "main" };
  const rows = [
    toRow({ sha: "a1", author: "codex-8", when: "1h", subject: "#13970 Restore at login" }, ctx),
    toRow({ sha: "b2", author: "sashabogi", when: "2h", subject: "Tidy the bar" }, ctx),
  ];
  it("parses keyed words and free text", () => {
    expect(parseSearch("restore card:13970 author:Cod")).toEqual({ text: "restore", card: 13970, author: "cod" });
  });
  it("filters by card, seat, author and text together", () => {
    expect(filterHistory(rows, parseSearch("card:13970")).rows.map(r => r.sha)).toEqual(["a1"]);
    expect(filterHistory(rows, parseSearch("seat:codex")).rows.map(r => r.sha)).toEqual(["a1"]);
    expect(filterHistory(rows, parseSearch("author:sasha tidy")).rows.map(r => r.sha)).toEqual(["b2"]);
  });
  it("reports file: as unsupported instead of matching nothing", () => {
    const r = filterHistory(rows, parseSearch("file:a.ts"));
    expect(r.fileUnsupported).toBe(true);
    expect(r.rows).toHaveLength(2);
  });
});

describe("branch picker grouping", () => {
  const seat = (name: string, extra: Partial<SeatInfo> = {}): SeatInfo => ({ seat: name, presence: "ready", branch: `seat/${name}`, ahead: null, machine: null, hasWorktree: true, ...extra });
  const seats = [seat("kimi-9"), seat("codex-8", { ahead: 3 }), seat("orchestrator", { hasWorktree: false, branch: null })];
  it("puts the checkout in its own section and only worktree seats under Seats", () => {
    const g = groupBranches({ seats, filter: "", show: "all", sort: "recent" });
    expect(g.checkout).toHaveLength(1);
    expect(g.seats.map(s => s.branchLabel)).toEqual(["seat/kimi-9", "seat/codex-8"]);
  });
  it("sorts A to Z, filters, and drops the checkout under Seats only", () => {
    expect(groupBranches({ seats, filter: "", show: "all", sort: "name" }).seats.map(s => s.seat)).toEqual(["codex-8", "kimi-9"]);
    expect(groupBranches({ seats, filter: "codex", show: "all", sort: "recent" }).seats).toHaveLength(1);
    expect(groupBranches({ seats, filter: "", show: "seats", sort: "recent" }).checkout).toHaveLength(0);
  });
});

describe("sidebar fold rule", () => {
  it("folds while the full Source control tab is open, unless the operator brings it back", () => {
    expect(sidebarVisible("source", false)).toBe(false);
    expect(sidebarVisible("source", true)).toBe(true);
    expect(sidebarVisible("pr", false)).toBe(false);
    expect(sidebarVisible("file", false)).toBe(true);
  });
});

describe("tabs", () => {
  it("never closes the Source control tab and falls back to the left neighbour", () => {
    const file = { id: "f", kind: "file" as const, label: "a.ts", scope: null, path: "a.ts" };
    const tabs = openTab([SOURCE_TAB], file);
    expect(closeTab(tabs, "f", "source").tabs).toHaveLength(2);
    expect(closeTab(tabs, "f", "f")).toEqual({ tabs: [SOURCE_TAB], activeId: "source" });
    expect(openTab(tabs, file)).toBe(tabs);
  });
});

describe("unified diff parsing", () => {
  const patch = ["diff --git a/x.ts b/x.ts", "index 1..2 100644", "--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,3 @@ fn", " keep", "-old", "+new", " tail", "diff --git a/n.ts b/n.ts", "new file mode 100644", "@@ -0,0 +1 @@", "+hello"].join("\n");
  it("reads files, statuses, counts and line numbers", () => {
    const files = parseUnifiedDiff(patch);
    expect(files.map(f => [f.path, f.status, f.plus, f.minus])).toEqual([["x.ts", "M", 1, 1], ["n.ts", "A", 1, 0]]);
    expect(files[0].hunks[0].lines[2]).toMatchObject({ kind: "add", newNo: 2, oldNo: null });
  });
  it("pairs a deletion with its addition side by side", () => {
    const rows = pairHunk(parseUnifiedDiff(patch)[0].hunks[0]);
    expect(rows[1].left?.text).toBe("old");
    expect(rows[1].right?.text).toBe("new");
  });
});

describe("conflict markers", () => {
  const text = ["a", "<<<<<<< HEAD", "mine", "=======", "theirs", ">>>>>>> main", "z", ""].join("\n");
  it("finds the conflict and resolves each choice", () => {
    const chunks = parseConflicts(text);
    expect(countConflicts(chunks)).toBe(1);
    expect(resolveChunks(chunks, new Map([[0, "ours"]]))).toBe("a\nmine\nz\n");
    expect(resolveChunks(chunks, new Map([[0, "theirs"]]))).toBe("a\ntheirs\nz\n");
    expect(resolveChunks(chunks, new Map([[0, "both"]]))).toBe("a\nmine\ntheirs\nz\n");
  });
  it("keeps the markers on a conflict nobody picked", () => {
    expect(resolveChunks(parseConflicts(text), new Map())).toBe(text);
  });
});
