#!/usr/bin/env node
// #13871: a handoff's progress must come from git, the board and a memory file, not one model
// summary written at a full context. Hermetic: temp HOME, temp AGENT_BUS_DIR, no hub, no LLM.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
};

const out = new URL("../../.agent-bus-out/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(out, "curstate-"));
process.env.HOME = dir;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.AGENT_BUS_DIR = join(dir, "bus");
process.env.RELAY_URL = "http://127.0.0.1:1";
process.env.TRANTOR_NO_SCROOGE = "1";
process.env.TRANTOR_NO_HANDOFF_SPAWN = "1";

const { gitFacts, computeFacts, renderFacts, stateTurnLabel, handoffFactsBlock } = await import("../../hooks/lib/handoff-facts.mjs");
const { applyCurrentState, appendProgress, currentStatePath, STATE_FILE } = await import("../../hooks/lib/current-state.mjs");
const { writeHandoff, readFirstPaths } = await import("../../hooks/lib/handoff.mjs");
const { progressFor } = await import("../../hooks/progress-log.mjs");
const { memoryDirectory } = await import("../../lib/memory-pins.mjs");
const { DERIVED_NOTE } = await import("../../lib/state/derive.mjs");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const commit = (cwd, msg) => { writeFileSync(join(cwd, `f-${Math.random().toString(36).slice(2)}.txt`), msg); git(cwd, "add", "."); git(cwd, "commit", "-m", msg); };

// A repo with a bare upstream, two commits ahead.
const bare = join(dir, "origin.git");
const repo = join(dir, "proj");
mkdirSync(repo, { recursive: true });
git(dir, "init", "--bare", "-b", "main", bare);
git(repo, "init", "-b", "main");
commit(repo, "one");
git(repo, "remote", "add", "origin", bare);
git(repo, "push", "-u", "origin", "main");
commit(repo, "two");
commit(repo, "three");

console.log("\nthe facts come from git and the board");
{
  const g = gitFacts(repo);
  ok("unpushed count comes from git against the upstream", g.ahead === 2 && g.branch === "main" && g.upstream === "origin/main", JSON.stringify(g));
  const lone = join(dir, "lone");
  mkdirSync(lone);
  git(lone, "init", "-b", "main");
  commit(lone, "x");
  const l = gitFacts(lone);
  ok("no upstream reports unknown, not zero", l.ahead === null && l.upstream === "" && l.branch === "main", JSON.stringify(l));
  ok("…and says so in words", /no upstream configured, so the unpushed count is unknown/.test(renderFacts({ computedAt: "t", ...l, board: { ok: true, counts: {}, cards: [] } })));

  const up = computeFacts({ projectDir: repo, projectName: "p", hubGet: () => ({ ok: false, reason: "curl timed out after 3s" }) });
  const txt = renderFacts(up);
  ok("a hub timeout is stated, not read as an empty board", !up.board.ok && /could not be read at handoff \(curl timed out after 3s\)/.test(txt), txt);
  ok("…and the git half still lands", /Branch main: 2 commit\(s\) ahead of origin\/main, unpushed/.test(txt));

  const board = computeFacts({ projectDir: repo, projectName: "p", hubGet: (path) => ({ ok: /catchup\?project=p/.test(path), json: {
    counts: { doing: 1, todo: 2 }, doing: [{ id: 7, title: "Fix the thing", assignee: "codex:p" }], todo: [{ id: 9, title: "Later" }] } }) });
  const bt = renderFacts(board);
  ok("open cards ride the facts with their status", /#7 doing \(codex:p\): Fix the thing/.test(bt) && /#9 todo: Later/.test(bt) && /1 doing, 0 testing/.test(bt), bt);
  ok("the block is labeled as computed, not written by the model", /not written by the model/.test(bt));
}

console.log("\nthe current-state file");
const memDir = memoryDirectory(repo);
mkdirSync(memDir, { recursive: true });
const dated = join(memDir, "project_session_handoff_2026_08_28.md");
writeFileSync(dated, "---\nname: old\ndescription: old\nmetadata:\n  type: project\n---\nold body\n");
const pad = ("- [pad](pad.md) — " + "x".repeat(70) + "\n").repeat(84);
writeFileSync(join(memDir, "MEMORY.md"), `# Index\n- [Old handoff](project_session_handoff_2026_08_28.md) — old\n${pad}`);
const SUMMARY = `# HANDOFF\n\n## TASK\nShip the thing.\n\n## READ FIRST\n- ${dated}\n- docs/PRD.md\n\n## OPEN THREADS\n1. do it\n`;
mkdirSync(join(repo, "docs"), { recursive: true });
writeFileSync(join(repo, "docs/PRD.md"), "prd");
const facts = computeFacts({ projectDir: repo, projectName: "proj", hubGet: () => ({ ok: false, reason: "down" }) });
const rec = { id: "proj-100", projectName: "proj", projectDir: repo, stamp: 1_800_000_000, summary: SUMMARY, state: { task: "Ship the thing", done: [{ id: "d1", text: "wrote it" }], in_flight: [], next: [{ id: "n1", text: "test it" }] } };
const first = applyCurrentState({ record: rec, projectDir: repo, facts });
const body1 = readFileSync(first, "utf8");
ok("the file is written under the memory dir with memory frontmatter", first === currentStatePath(repo) && /^---\nname: project_current_state\n/.test(body1) && /metadata:\n  node_type: memory\n  type: project/.test(body1), body1.slice(0, 160));
ok("it holds task, facts, done, in flight, next and the handoff id", ["Ship the thing", "## Facts", "wrote it", "## In flight", "test it", "proj-100", "2 commit(s) ahead"].every(s => body1.includes(s)), body1);

appendProgress(repo, "commit abc123 first", new Date("2026-11-19T10:00:00Z"));
const rec2 = { ...rec, id: "proj-200", summary: SUMMARY, state: null };
applyCurrentState({ record: rec2, projectDir: repo, facts });
const body2 = readFileSync(first, "utf8");
ok("a second handoff REPLACES the file (new id, old id gone)", body2.includes("proj-200") && !body2.includes("proj-100"));
ok("…but the progress lines survive the rewrite", body2.includes("commit abc123 first"));
const index = readFileSync(join(memDir, "MEMORY.md"), "utf8");
ok("exactly ONE index line for it, after two handoffs and a progress append", index.split("\n").filter(l => l.includes(`(${STATE_FILE})`)).length === 1);
ok("…updated in place with the newest id", index.includes("proj-200") && !index.includes("proj-100"));

console.log("\nREAD FIRST");
ok("it names the current-state file first", readFirstPaths(rec.summary, { projectDir: repo })[0] === first, JSON.stringify(readFirstPaths(rec.summary, { projectDir: repo })));
ok("…and never a dated session-handoff note", !/project_session_handoff_/.test(rec.summary.split("## OPEN THREADS")[0]));
ok("…while the other read-first paths stay", rec.summary.includes("docs/PRD.md"));
ok("dated notes are marked superseded after their frontmatter and NOT deleted", existsSync(dated)
  && /^---\n[\s\S]*?\n---\n> superseded by project_current_state\.md\nold body/.test(readFileSync(dated, "utf8")));
applyCurrentState({ record: { ...rec2 }, projectDir: repo, facts });
ok("…and a later handoff does not stack a second marker", readFileSync(dated, "utf8").split("superseded by").length === 2);
ok("it works when the model's summary named no READ FIRST at all", (() => {
  const r = { ...rec2, summary: "# H\n\n## TASK\nx\n" };
  applyCurrentState({ record: r, projectDir: repo, facts });
  return r.summary.endsWith(`## READ FIRST\n${first}`);
})());

console.log("\nthe memory cap warning");
{
  ok("MEMORY.md over 7.5 KB puts one plain line on the record", /near its cap and needs pruning/.test(rec.memoryWarning || ""), String(rec.memoryWarning));
  const claimed = handoffFactsBlock({ ...rec, facts }, true);
  const peeked = handoffFactsBlock({ ...rec, facts }, false);
  ok("the claiming successor gets it exactly once", claimed.split("needs pruning").length === 2);
  ok("a non-claiming peek (compact) does not repeat it", !/needs pruning/.test(peeked));
  ok("the facts block names the state file to read", claimed.includes(`Read first: ${first}`) && /not model-written/.test(claimed));
  const small = mkdtempSync(join(out, "curstate-small-"));
  const smallRepo = join(small, "p"); mkdirSync(smallRepo);
  const r3 = { id: "p-1", projectName: "p", stamp: 1, summary: "# H", state: null };
  applyCurrentState({ record: r3, projectDir: smallRepo, facts });
  ok("an index under the threshold says nothing", r3.memoryWarning === "");
  rmSync(small, { recursive: true, force: true });
}

console.log("\nthrough writeHandoff");
{
  const { record, file } = writeHandoff({ projectDir: repo, projectName: "proj", sessionId: "s1", transcript: "", trigger: "manual-skill", summary: SUMMARY, force: true });
  ok("the record carries the computed facts", record.facts?.ahead === 2 && record.facts.board.ok === false);
  ok("…and the current-state path and cap warning", record.currentStatePath === first && /near its cap/.test(record.memoryWarning));
  ok("READ FIRST on the stored record names the state file, not the dated note", readFirstPaths(record.summary, { projectDir: repo })[0] === first && !/READ FIRST[\s\S]*project_session_handoff/.test(record.summary));
  rmSync(file, { force: true });
}

console.log("\nin-session progress");
{
  const fresh = join(dir, "fresh"); mkdirSync(fresh);
  git(fresh, "init", "-b", "main");
  const fm = memoryDirectory(fresh); mkdirSync(fm, { recursive: true });
  ok("no state file and no memory dir means no write", appendProgress(join(dir, "nowhere"), "x") === false);
  ok("a card move yields a progress line", progressFor({ tool_name: "mcp__plugin_trantor_relay__relay_task_move", tool_input: { id: 12, status: "testing", note: "done: 5 pass" } }) === "card #12 -> testing: done: 5 pass");
  ok("a failed card move yields none", progressFor({ tool_name: "mcp__plugin_trantor_relay__relay_task_move", tool_input: { id: 12, status: "done" }, tool_response: { isError: true } }) === "");
  commit(fresh, "fix the widget");
  const run = (input) => spawnSync(process.execPath, [new URL("../../hooks/progress-log.mjs", import.meta.url).pathname], { input: JSON.stringify(input), encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, HOME: dir } });
  const r = run({ tool_name: "Bash", cwd: fresh, tool_input: { command: "git commit -m x" } });
  const text = readFileSync(join(fm, STATE_FILE), "utf8");
  ok("the hook appends a dated commit line and exits clean", r.status === 0 && /- \d{4}-\d\d-\d\d \d\d:\d\d commit [0-9a-f]+ fix the widget/.test(text), r.stderr + text);
  ok("…creating the index line too", readFileSync(join(fm, "MEMORY.md"), "utf8").includes(`(${STATE_FILE})`));
  run({ tool_name: "Bash", cwd: fresh, tool_input: { command: "ls" } });
  run({ tool_name: "mcp__plugin_trantor_relay__relay_task_move", cwd: fresh, tool_input: { id: 3, status: "doing" } });
  const after = readFileSync(join(fm, STATE_FILE), "utf8");
  ok("a Bash call that is not a commit adds nothing; a card move adds its line", after.split("\n").filter(l => l.startsWith("- 20")).length === 2 && after.includes("card #3 -> doing"), after);
  ok("one index line still", readFileSync(join(fm, "MEMORY.md"), "utf8").split("\n").filter(l => l.includes(STATE_FILE)).length === 1);
}

console.log("\nthe turn label");
{
  ok("a real turn is shown", stateTurnLabel({ cursor: { turn: 7 }, notes: "" }) === ", turn 7");
  ok("turn 0 is dropped, not printed", stateTurnLabel({ cursor: { turn: 0 } }) === "");
  ok("a state derived at handoff drops the placeholder number", stateTurnLabel({ cursor: { turn: 1 }, notes: `${DERIVED_NOTE}\nmore` }) === "");
  ok("a missing cursor is dropped", stateTurnLabel({}) === "");
  const src = readFileSync(new URL("../../hooks/sessionstart.mjs", import.meta.url), "utf8");
  ok("sessionstart no longer prints the bare turn", !/turn \$\{sanitize\(String\(handoff\.state\.cursor/.test(src) && src.includes("stateTurnLabel(handoff.state)") && src.includes("handoffFactsBlock(handoff, claimed"));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
