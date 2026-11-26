// TOOL GROUPS (#14327): how a turn's tool calls fold into rows and how each row is worded. Pure on
// purpose: the transcript renders what this returns and owns no grouping rules of its own.
import type { Block, ToolKind, ToolResult } from "./streaming";

/** One tool call: its block, the result once it arrived, and the facts rows are drawn from. */
export type Call = { block: Block; result?: ToolResult; kind: ToolKind; failed: boolean; running: boolean };

export type Item =
  /** text, thinking, ask, image and the rest pass through untouched */
  | { type: "block"; block: Block }
  /** one call as its own row; failed calls come flagged `open` so they show their output */
  | { type: "call"; call: Call; open: boolean }
  | { type: "group"; calls: Call[]; summary: string; running: boolean }
  /** a finished turn's work folded above its reply; `items` are the originals to expand into */
  | { type: "fold"; items: Item[]; calls: Call[]; summary: string };

const FALLBACK_KIND = new Map<string, ToolKind>([
  ["Read", "explore"], ["Grep", "explore"], ["Glob", "explore"], ["LS", "explore"], ["WebFetch", "explore"], ["WebSearch", "explore"],
  ["Edit", "edit"], ["MultiEdit", "edit"], ["NotebookEdit", "edit"], ["Write", "write"], ["TodoWrite", "todo"], ["Bash", "command"],
]);

function kindOf(block: Block): ToolKind {
  if (block.tool_kind) return block.tool_kind;
  return (block.tool ? FALLBACK_KIND.get(block.tool) : undefined) ?? "other";
}

function isFailed(result: ToolResult | undefined): boolean {
  if (!result) return false;
  return !result.ok || (result.exit_code !== undefined && result.exit_code !== 0);
}

export function toCall(block: Block, results: Record<string, ToolResult>): Call {
  const result = block.tool_id ? results[block.tool_id] : undefined;
  return { block, result, kind: kindOf(block), failed: isFailed(result), running: result === undefined };
}

const isAsk = (b: Block) => b.tool === "AskUserQuestion";
const isToolBlock = (b: Block) => b.kind === "tool" && !isAsk(b);
/** Failed calls and commits stand alone; everything else may fold. */
const foldable = (c: Call) => !c.failed && c.kind !== "commit";

function pushRun(out: Item[], run: Call[]) {
  if (run.length >= 2) out.push({ type: "group", calls: run, summary: summary(run), running: run.some(c => c.running) });
  else if (run[0]) out.push({ type: "call", call: run[0], open: false });
}

/** A turn's blocks as rows: text and friends pass through, runs of 2+ foldable calls become one
 *  group, a failed call or a commit is its own row (failed ones open), a lone call is its own row. */
export function groupBlocks(blocks: Block[], results: Record<string, ToolResult>): Item[] {
  const out: Item[] = [];
  let run: Call[] = [];
  const flush = () => { pushRun(out, run); run = []; };
  for (const block of blocks) {
    if (!isToolBlock(block)) { flush(); out.push({ type: "block", block }); continue; }
    const call = toCall(block, results);
    if (foldable(call)) { run.push(call); continue; }
    flush();
    out.push({ type: "call", call, open: call.failed });
  }
  flush();
  return out;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const FILE_READERS = new Set(["cat", "head", "tail", "sed", "wc"]);
const firstWord = (text: string) => text.trim().split(/\s+/)[0] ?? "";

/** An explore call is a file look (Read, cat, sed -n) or a search (Grep, Glob, LS, web, grep, ls). */
function exploreIsFile(call: Call): boolean {
  if (call.block.tool === "Read") return true;
  return call.block.tool === "Bash" && FILE_READERS.has(firstWord(call.block.text));
}

function distinctFiles(calls: Call[]): number {
  const paths = new Set<string>();
  let anonymous = 0;
  for (const c of calls) {
    const p = c.block.paths?.[0];
    if (p) paths.add(p);
    else anonymous++;
  }
  return paths.size + anonymous;
}

function verbFor(kind: ToolKind | undefined): string {
  if (kind === "explore") return "Exploring…";
  if (kind === "command") return "Running…";
  if (kind === "edit") return "Editing…";
  if (kind === "write") return "Writing…";
  if (kind === "commit") return "Committing…";
  return "Working…";
}

/** "Explored 6 files, ran 4 commands, 1 failed", or "Exploring…" while a call is still running. */
export function summary(calls: Call[]): string {
  const running = calls.filter(c => c.running).pop();
  if (running) return verbFor(running.kind);
  const failed = calls.filter(c => c.failed);
  const ok = calls.filter(c => !c.failed);
  const of = (kind: ToolKind) => ok.filter(c => c.kind === kind);
  const phrases: string[] = [];

  const explore = of("explore");
  if (explore.length) {
    const files = distinctFiles(explore.filter(exploreIsFile));
    const searches = explore.filter(c => !exploreIsFile(c)).length;
    const parts = [files ? count(files, "file", "files") : "", searches ? count(searches, "search", "searches") : ""].filter(Boolean);
    phrases.push(`explored ${parts.join(", ")}`);
  }
  const commits = of("commit");
  if (commits.length) phrases.push(`committed ${count(commits.length, "commit", "commits")}`);
  const edits = of("edit");
  if (edits.length) phrases.push(`edited ${count(distinctFiles(edits), "file", "files")}`);
  const writes = of("write");
  if (writes.length) phrases.push(`wrote ${count(distinctFiles(writes), "file", "files")}`);
  const commands = of("command");
  if (commands.length) phrases.push(`ran ${count(commands.length, "command", "commands")}`);
  const others = ok.filter(c => c.kind === "other" || c.kind === "todo");
  if (others.length) phrases.push(`used ${count(others.length, phrases.length ? "other tool" : "tool", phrases.length ? "other tools" : "tools")}`);
  if (failed.length) phrases.push(`${failed.length} failed`);

  const text = phrases.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type Row = { verb: string; object: string; failed: boolean };

const COMMIT_MESSAGE = /-m\s+(?:"([^"]*)"|'([^']*)')/;

function objectOf(call: Call): string {
  const { block } = call;
  if (call.kind === "commit") {
    const m = COMMIT_MESSAGE.exec(block.text);
    return m?.[1] ?? m?.[2] ?? block.text;
  }
  if (call.kind === "todo") return "to-do list";
  if (block.tool && block.tool !== "Bash" && call.kind === "other") return block.text || block.tool;
  return block.text;
}

const VERBS = new Map<string, [string, string]>([
  ["Read", ["Read", "Couldn't read"]],
  ["Grep", ["Searched for", "Couldn't search for"]],
  ["Glob", ["Searched for", "Couldn't search for"]],
  ["LS", ["Listed", "Couldn't list"]],
  ["WebFetch", ["Fetched", "Couldn't fetch"]],
  ["WebSearch", ["Searched the web for", "Couldn't search the web for"]],
]);

const KIND_VERBS = {
  explore: ["Looked at", "Couldn't look at"],
  edit: ["Edited", "Couldn't edit"],
  write: ["Wrote", "Couldn't write"],
  command: ["Ran", "Couldn't run"],
  commit: ["Committed", "Couldn't commit"],
  todo: ["Updated", "Couldn't update"],
  other: ["Used", "Couldn't use"],
} as const satisfies Record<ToolKind, readonly [string, string]>;

function verbsFor(call: Call): [string, string] {
  if (call.block.tool === "Bash" && call.kind === "explore") {
    return exploreIsFile(call) ? ["Read", "Couldn't read"] : ["Searched for", "Couldn't search for"];
  }
  return (call.block.tool ? VERBS.get(call.block.tool) : undefined) ?? [...KIND_VERBS[call.kind]];
}

/** A lone call as a row: a verb and what it acted on, in the failure form when it failed. */
export function singleRow(call: Call): Row {
  const [done, failed] = verbsFor(call);
  return { verb: call.failed ? failed : done, object: objectOf(call), failed: call.failed };
}

/** For a finished turn, everything before the final text block folds into one summary row.
 *  Failed calls, commits, asks and the narration text between calls stay where they are. */
export function foldBeforeReply(items: Item[], finished: boolean): Item[] {
  if (!finished) return items;
  let last = -1;
  items.forEach((it, i) => { if (it.type === "block" && it.block.kind === "text") last = i; });
  if (last <= 0) return items;
  const folded: Item[] = [];
  const calls: Call[] = [];
  const kept: Item[] = [];
  let at = -1;
  items.slice(0, last).forEach(it => {
    const takes = it.type === "group" || (it.type === "call" && !it.open && foldable(it.call)) || (it.type === "block" && it.block.kind === "thinking");
    if (!takes) { kept.push(it); return; }
    if (at < 0) at = kept.length;
    folded.push(it);
    if (it.type === "group") calls.push(...it.calls);
    else if (it.type === "call") calls.push(it.call);
  });
  if (calls.length === 0) return items;
  kept.splice(at, 0, { type: "fold", items: folded, calls, summary: summary(calls) });
  return [...kept, ...items.slice(last)];
}
