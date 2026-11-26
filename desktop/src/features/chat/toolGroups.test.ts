import { describe, expect, it } from "vitest";
import type { Block, ToolResult } from "./streaming";
import { foldBeforeReply, groupBlocks, singleRow, summary, toCall, type Call, type Item } from "./toolGroups";

let seq = 0;
const tool = (name: string, text: string, extra: Partial<Block> = {}): Block => ({ kind: "tool", tool: name, text, tool_id: `t${++seq}`, ...extra });
const text = (t: string): Block => ({ kind: "text", text: t });
const done = (b: Block, extra: Partial<ToolResult> = {}): [string, ToolResult] => [b.tool_id ?? "", { tool_id: b.tool_id ?? "", ok: true, preview: "", ...extra }];
const resultsFor = (blocks: Block[], overrides: Record<string, Partial<ToolResult>> = {}): Record<string, ToolResult> =>
  Object.fromEntries(blocks.filter(b => b.kind === "tool").map(b => done(b, overrides[b.tool_id ?? ""] ?? {})));

const read = (path: string) => tool("Read", path, { tool_kind: "explore", paths: [path] });
const grep = (pattern: string) => tool("Grep", pattern, { tool_kind: "explore" });
const edit = (path: string) => tool("Edit", path, { tool_kind: "edit", paths: [path] });
const write = (path: string) => tool("Write", path, { tool_kind: "write", paths: [path] });
const bash = (cmd: string, kind: Block["tool_kind"] = "command") => tool("Bash", cmd, { tool_kind: kind });
const commit = (cmd: string) => bash(cmd, "commit");
const callOf = (b: Block, r: Partial<ToolResult> | null = {}): Call => toCall(b, r ? resultsFor([b], { [b.tool_id ?? ""]: r }) : {});
const types = (items: Item[]) => items.map(i => i.type);

describe("summary", () => {
  const sum = (blocks: Block[], overrides: Record<string, Partial<ToolResult>> = {}) => {
    const results = resultsFor(blocks, overrides);
    return summary(blocks.map(b => toCall(b, results)));
  };

  it.each([
    ["files and searches", () => [read("/a"), read("/b"), grep("x")], "Explored 2 files, 1 search"],
    ["distinct paths only", () => [read("/a"), read("/a"), read("/b")], "Explored 2 files"],
    ["searches only", () => [grep("x"), grep("y")], "Explored 2 searches"],
    ["one file", () => [read("/a")], "Explored 1 file"],
    ["commits", () => [commit("git commit -m a"), commit("git commit -m b")], "Committed 2 commits"],
    ["one commit", () => [commit("git commit -m a")], "Committed 1 commit"],
    ["edits count distinct files", () => [edit("/a"), edit("/a"), edit("/b")], "Edited 2 files"],
    ["one edit", () => [edit("/a")], "Edited 1 file"],
    ["writes", () => [write("/a"), write("/b")], "Wrote 2 files"],
    ["commands", () => [bash("npm test"), bash("npm run build")], "Ran 2 commands"],
    ["one command", () => [bash("npm test")], "Ran 1 command"],
    ["other tools alone drop the word other", () => [tool("Task", "x"), tool("WebX", "y")], "Used 2 tools"],
    ["one other tool alone", () => [tool("Task", "x")], "Used 1 tool"],
    ["other tools after a phrase say other", () => [read("/a"), tool("Task", "x"), tool("Task", "y")], "Explored 1 file, used 2 other tools"],
    ["one other tool after a phrase", () => [bash("ls", "explore"), tool("Task", "x")], "Explored 1 search, used 1 other tool"],
    ["todo counts as other", () => [edit("/a"), tool("TodoWrite", "plan", { tool_kind: "todo" })], "Edited 1 file, used 1 other tool"],
    ["the spec order", () => [bash("npm test"), tool("Task", "x"), write("/w"), edit("/e"), commit("git commit -m z"), read("/r"), grep("g")],
      "Explored 1 file, 1 search, committed 1 commit, edited 1 file, wrote 1 file, ran 1 command, used 1 other tool"],
  ])("%s", (_name, make, want) => {
    expect(sum(make())).toBe(want);
  });

  it("shell reads count as files or searches by the command", () => {
    expect(sum([bash("cat a.ts", "explore"), bash("sed -n 1,5p b.ts", "explore"), bash("rg foo src", "explore"), bash("ls", "explore")])).toBe("Explored 2 files, 2 searches");
  });

  it("failed calls are counted as failed, not as their kind", () => {
    const b = [bash("npm test"), bash("npm run lint")];
    expect(sum(b, { [b[1]?.tool_id ?? ""]: { ok: false } })).toBe("Ran 1 command, 1 failed");
    const only = [read("/a")];
    expect(sum(only, { [only[0]?.tool_id ?? ""]: { ok: false } })).toBe("1 failed");
  });

  it("a nonzero exit code is a failure even when the result is not flagged", () => {
    const b = bash("npm test");
    expect(callOf(b, { exit_code: 2 }).failed).toBe(true);
    expect(callOf(b, { exit_code: 0 }).failed).toBe(false);
    expect(callOf(b, { exit_code: undefined }).failed).toBe(false);
  });

  it("a group with a running call says what is running", () => {
    const [a, b] = [read("/a"), read("/b")];
    expect(summary([toCall(a, resultsFor([a])), toCall(b, {})])).toBe("Exploring…");
    const c = bash("npm test");
    expect(summary([toCall(a, resultsFor([a])), toCall(c, {})])).toBe("Running…");
    expect(summary([toCall(edit("/x"), {})])).toBe("Editing…");
    expect(summary([toCall(write("/x"), {})])).toBe("Writing…");
    expect(summary([toCall(commit("git commit -m x"), {})])).toBe("Committing…");
    expect(summary([toCall(tool("Task", "x"), {})])).toBe("Working…");
  });

  it("tools without backend facts fall back to their name", () => {
    const plain = [tool("Read", "/a"), tool("Grep", "x"), tool("Edit", "/e"), tool("Bash", "npm test"), tool("Task", "t")];
    expect(sum(plain)).toBe("Explored 1 file, 1 search, edited 1 file, ran 1 command, used 1 other tool");
  });
});

describe("groupBlocks", () => {
  it("passes text, thinking and images through", () => {
    const blocks: Block[] = [text("hi"), { kind: "thinking", text: "hm" }, { kind: "image", text: "image" }];
    const items = groupBlocks(blocks, {});
    expect(items.map(i => i.type === "block" && i.block.kind)).toEqual(["text", "thinking", "image"]);
  });

  it("folds two or more consecutive calls into one group", () => {
    const blocks = [read("/a"), read("/b"), grep("x")];
    const [g, ...rest] = groupBlocks(blocks, resultsFor(blocks));
    expect(rest).toEqual([]);
    expect(g?.type === "group" && g.calls.length).toBe(3);
    expect(g?.type === "group" && g.summary).toBe("Explored 2 files, 1 search");
    expect(g?.type === "group" && g.running).toBe(false);
  });

  it("a single call is its own row", () => {
    const blocks = [text("a"), read("/a"), text("b")];
    expect(types(groupBlocks(blocks, resultsFor(blocks)))).toEqual(["block", "call", "block"]);
  });

  it("text between calls splits the runs", () => {
    const blocks = [read("/a"), read("/b"), text("mid"), read("/c"), read("/d")];
    expect(types(groupBlocks(blocks, resultsFor(blocks)))).toEqual(["group", "block", "group"]);
  });

  it("a failed call is never folded and opens itself", () => {
    const blocks = [read("/a"), read("/b"), bash("npm test"), read("/c"), read("/d")];
    const results = resultsFor(blocks, { [blocks[2]?.tool_id ?? ""]: { ok: false, exit_code: 1 } });
    const items = groupBlocks(blocks, results);
    expect(types(items)).toEqual(["group", "call", "group"]);
    const failed = items[1];
    expect(failed?.type === "call" && failed.open).toBe(true);
    expect(failed?.type === "call" && failed.call.failed).toBe(true);
  });

  it("a commit is never folded, even beside other calls", () => {
    const blocks = [edit("/a"), edit("/b"), commit("git commit -m x"), bash("git push")];
    const items = groupBlocks(blocks, resultsFor(blocks));
    expect(types(items)).toEqual(["group", "call", "call"]);
    const c = items[1];
    expect(c?.type === "call" && c.open).toBe(false);
  });

  it("a failed commit is a failed call, open", () => {
    const b = commit("git commit -m x");
    const [item] = groupBlocks([b], resultsFor([b], { [b.tool_id ?? ""]: { ok: false } }));
    expect(item?.type === "call" && item.open).toBe(true);
  });

  it("an ask passes through as a block and splits the run", () => {
    const ask: Block = { kind: "tool", tool: "AskUserQuestion", text: "which?", tool_id: "ask1", ask: [] };
    const blocks = [read("/a"), read("/b"), ask, read("/c")];
    const items = groupBlocks(blocks, resultsFor(blocks));
    expect(types(items)).toEqual(["group", "block", "call"]);
  });

  it("calls without results are running, and the group says so", () => {
    const blocks = [read("/a"), read("/b")];
    const [g] = groupBlocks(blocks, {});
    expect(g?.type === "group" && g.running).toBe(true);
    expect(g?.type === "group" && g.summary).toBe("Exploring…");
  });

  it("a running single call is a call item, not failed", () => {
    const [item] = groupBlocks([bash("npm test")], {});
    expect(item?.type === "call" && item.call.running).toBe(true);
    expect(item?.type === "call" && item.open).toBe(false);
  });
});

describe("singleRow", () => {
  it.each([
    ["Read", () => read("/src/a.ts"), "Read", "/src/a.ts"],
    ["Grep", () => grep("foo  in src"), "Searched for", "foo  in src"],
    ["Glob", () => tool("Glob", "*.ts", { tool_kind: "explore" }), "Searched for", "*.ts"],
    ["LS", () => tool("LS", "/src", { tool_kind: "explore" }), "Listed", "/src"],
    ["WebFetch", () => tool("WebFetch", "https://x.dev", { tool_kind: "explore" }), "Fetched", "https://x.dev"],
    ["WebSearch", () => tool("WebSearch", "tauri", { tool_kind: "explore" }), "Searched the web for", "tauri"],
    ["Edit", () => edit("/a.ts"), "Edited", "/a.ts"],
    ["Write", () => write("/n.md"), "Wrote", "/n.md"],
    ["Bash", () => bash("npm test"), "Ran", "npm test"],
    ["shell read", () => bash("cat a.ts", "explore"), "Read", "cat a.ts"],
    ["shell search", () => bash("rg foo", "explore"), "Searched for", "rg foo"],
    ["todo", () => tool("TodoWrite", "x", { tool_kind: "todo" }), "Updated", "to-do list"],
    ["other", () => tool("Task", "Review the diff"), "Used", "Review the diff"],
    ["other with no text", () => tool("Mystery", ""), "Used", "Mystery"],
  ])("%s", (_name, make, verb, object) => {
    expect(singleRow(callOf(make()))).toEqual({ verb, object, failed: false });
  });

  it("a commit shows its message", () => {
    expect(singleRow(callOf(commit(`git commit -m "#1 Fix it"`)))).toEqual({ verb: "Committed", object: "#1 Fix it", failed: false });
    expect(singleRow(callOf(commit("git commit -m 'single'"))).object).toBe("single");
    expect(singleRow(callOf(commit("git commit --amend"))).object).toBe("git commit --amend");
  });

  it.each([
    ["Read", () => read("/a"), "Couldn't read"],
    ["Grep", () => grep("x"), "Couldn't search for"],
    ["Edit", () => edit("/a"), "Couldn't edit"],
    ["Write", () => write("/a"), "Couldn't write"],
    ["Bash", () => bash("npm test"), "Couldn't run"],
    ["commit", () => commit("git commit -m x"), "Couldn't commit"],
    ["WebFetch", () => tool("WebFetch", "u", { tool_kind: "explore" }), "Couldn't fetch"],
    ["other", () => tool("Task", "t"), "Couldn't use"],
  ])("failure form: %s", (_name, make, verb) => {
    expect(singleRow(callOf(make(), { ok: false }))).toMatchObject({ verb, failed: true });
  });
});

describe("foldBeforeReply", () => {
  const turn = (blocks: Block[], overrides: Record<string, Partial<ToolResult>> = {}) => groupBlocks(blocks, resultsFor(blocks, overrides));

  it("leaves an unfinished turn alone", () => {
    const items = turn([read("/a"), read("/b"), text("reply")]);
    expect(foldBeforeReply(items, false)).toBe(items);
  });

  it("folds everything before the final text into one summary", () => {
    const items = foldBeforeReply(turn([read("/a"), read("/b"), edit("/c"), bash("npm test"), text("done")]), true);
    expect(types(items)).toEqual(["fold", "block"]);
    const fold = items[0];
    expect(fold?.type === "fold" && fold.summary).toBe("Explored 2 files, edited 1 file, ran 1 command");
    expect(fold?.type === "fold" && fold.items.length).toBe(1);
    expect(fold?.type === "fold" && fold.calls.length).toBe(4);
  });

  it("a turn with no tool calls before its reply is unchanged", () => {
    const items = turn([text("a"), text("b")]);
    expect(foldBeforeReply(items, true)).toBe(items);
  });

  it("a turn with no reply text is unchanged", () => {
    const items = turn([read("/a"), read("/b")]);
    expect(foldBeforeReply(items, true)).toBe(items);
  });

  it("failed calls, commits and asks stay out of the fold", () => {
    const ask: Block = { kind: "tool", tool: "AskUserQuestion", text: "which?", tool_id: "askx", ask: [] };
    const bad = bash("npm test");
    const items = foldBeforeReply(turn([read("/a"), read("/b"), bad, commit("git commit -m x"), ask, edit("/e"), text("reply")], { [bad.tool_id ?? ""]: { ok: false } }), true);
    expect(types(items)).toEqual(["fold", "call", "call", "block", "block"]);
    const fold = items[0];
    expect(fold?.type === "fold" && fold.summary).toBe("Explored 2 files, edited 1 file");
    const failed = items[1];
    expect(failed?.type === "call" && failed.open).toBe(true);
  });

  it("thinking folds with the calls, narration text stays", () => {
    const blocks: Block[] = [{ kind: "thinking", text: "hm" }, read("/a"), text("Looking now."), edit("/b"), text("All done.")];
    const items = foldBeforeReply(turn(blocks), true);
    expect(types(items)).toEqual(["fold", "block", "block"]);
    const fold = items[0];
    expect(fold?.type === "fold" && fold.items.length).toBe(3);
    expect(items.map(i => i.type === "block" && i.block.text)).toEqual([false, "Looking now.", "All done."]);
  });

  it("thinking alone is not folded away", () => {
    const items = turn([{ kind: "thinking", text: "hm" }, text("reply")]);
    expect(foldBeforeReply(items, true)).toBe(items);
  });

  it("calls after the final text are not folded", () => {
    const items = foldBeforeReply(turn([read("/a"), read("/b"), text("reply"), read("/c"), read("/d")]), true);
    expect(types(items)).toEqual(["fold", "block", "group"]);
  });
});
