#!/usr/bin/env node
// #12093 — Claude Code 2.1.294-2.1.304 hook drills: raw slash-command prompts (2.1.299), gating
// hooks answering inside their timeout (2.1.299), per-request transcript rows (2.1.300),
// PreCompact with a non-auto trigger (idle compaction), and the pinned claude -p permission mode.
import http from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";
import { contextUsage } from "../../hooks/lib/handoff.mjs";
import { lastAssistantText } from "../../hooks/lib/await-operator.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const W = mkdtempSync(join(tmpdir(), "trantor-cc12093-"));
const BUS = join(W, "bus");
const CWD = join(W, "proj");
mkdirSync(BUS, { recursive: true });
mkdirSync(CWD, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : (extra ? " — " + extra : "")}`);
};

// ---- recorder hub (answers everything) and a hub that accepts and never answers -----------------
const hits = [];
const hub = http.createServer((req, res) => {
  let b = ""; req.on("data", c => (b += c));
  req.on("end", () => {
    let body = {}; try { body = JSON.parse(b || "{}"); } catch {}
    hits.push({ path: req.url, method: req.method, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, peers: [], conflicts: [] }));
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;
const sockets = new Set();
const hang = http.createServer(() => { /* never responds */ });
hang.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
await new Promise(r => hang.listen(0, "127.0.0.1", r));
const HANG = `http://127.0.0.1:${hang.address().port}`;

const baseEnv = (extra = {}) => ({
  ...drillEnv(), HOME: W, AGENT_BUS_DIR: BUS,
  RELAY_PROJECT: "cc12093", RELAY_SESSION: "drillhost:cc12093", RELAY_URL: HUB,
  TRANTOR_NO_SCROOGE_TITLES: "1", ...extra,
});

// Runs a hook script. `payload === null` leaves stdin OPEN (a host that never hands its input over).
function runHook(script, payload, extraEnv = {}, { cwd = CWD, killAfterMs = 20000 } = {}) {
  hits.length = 0;
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn("node", [join(ROOT, "hooks", script)], { cwd, env: baseEnv(extraEnv), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const killer = setTimeout(() => p.kill("SIGKILL"), killAfterMs);
    p.stdout.on("data", d => (out += d)); p.stderr.on("data", d => (err += d));
    p.on("close", status => { clearTimeout(killer); setTimeout(() => resolve({ hits: [...hits], out, err, status, ms: Date.now() - t0 }), 120); });
    if (payload !== null) p.stdin.end(JSON.stringify(payload));
  });
}
const validJson = (s) => { try { JSON.parse(s); return true; } catch { return false; } };

// ═══ 1. UserPromptSubmit sees the RAW slash command (2.1.299) ═══════════════════════════════════
console.log("# 1. UserPromptSubmit hooks on a raw slash-command prompt");
const focusPosts = (r) => r.hits.filter(h => h.path === "/focus");
{
  const r = await runHook("prompt-focus.mjs", { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: CWD, prompt: "/trantor:handoff" });
  ok("prompt-focus: a bare /trantor:handoff makes no focus card", focusPosts(r).length === 0 && r.status === 0, JSON.stringify(r.hits));
  ok("prompt-focus: ...and still answers valid JSON", validJson(r.out));
}
{
  const r = await runHook("prompt-focus.mjs", { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: CWD, prompt: "/review-all-the-things" });
  ok("prompt-focus: a long bare command name still makes no focus card", focusPosts(r).length === 0);
}
{
  const r = await runHook("prompt-focus.mjs", { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: CWD, prompt: "/foo tighten the login redirect handling" });
  const posts = focusPosts(r);
  ok("prompt-focus: /command with arguments focuses on the arguments, not the command",
    posts.length === 1 && posts[0].body.title === "tighten the login redirect handling", JSON.stringify(posts.map(p => p.body)));
}
{
  const r = await runHook("prompt-focus.mjs", { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: CWD, prompt: "/foo go" });
  ok("prompt-focus: /command with a trivial argument makes no card", focusPosts(r).length === 0);
}
{
  const r = await runHook("prompt-focus.mjs", { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: CWD, prompt: "/Users/sasha/app/main.ts crashes on boot, please fix it" });
  const posts = focusPosts(r);
  ok("prompt-focus: a prompt that opens with an absolute path is NOT a command",
    posts.length === 1 && posts[0].body.title.startsWith("/Users/sasha/app/main.ts"), JSON.stringify(posts.map(p => p.body)));
}
{
  const r = await runHook("prompt-focus.mjs", { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: CWD, prompt: "fix the login redirect on the settings page" });
  ok("prompt-focus: an ordinary prompt still makes its card", focusPosts(r).length === 1);
}
{
  // ask-sidecar: closes the open ask on ANY prompt, whatever the text
  mkdirSync(join(BUS, "asks"), { recursive: true });
  const sidecar = join(BUS, "asks", "sc-12093.json");
  writeFileSync(sidecar, JSON.stringify({ session_id: "sc-12093", kind: "AskUserQuestion" }));
  const r = await runHook("ask-sidecar.mjs", { hook_event_name: "UserPromptSubmit", session_id: "sc-12093", cwd: CWD, prompt: "/trantor:handoff" });
  ok("ask-sidecar: a raw /command prompt closes the open ask and answers {}", !existsSync(sidecar) && r.out === "{}" && r.status === 0, JSON.stringify({ out: r.out, err: r.err.slice(0, 200) }));
}
{
  // await-operator: a prompt, any prompt, lifts the awaiting-operator stamp
  const stamp = join(BUS, "await-operator-drillhost_cc12093.json");
  writeFileSync(stamp, JSON.stringify({ ts: Date.now(), via: "question" }));
  const r = await runHook("await-operator.mjs", { hook_event_name: "UserPromptSubmit", session_id: "ao-12093", cwd: CWD, prompt: "/trantor:handoff" });
  const reg = r.hits.filter(h => h.path === "/register");
  ok("await-operator: a raw /command prompt clears the stamp and restores the idle status",
    !existsSync(stamp) && reg.length === 1 && reg[0].body.status === "active in cc12093" && r.out === "{}", JSON.stringify({ reg: reg.map(h => h.body), out: r.out }));
}

// ═══ 2. Gating hooks answer before their timeout (2.1.299) ══════════════════════════════════════
console.log("# 2. gating hooks fail open and fast");
const hooksJson = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
const declaredTimeout = (event, script) => {
  for (const g of hooksJson.hooks[event] || []) for (const h of g.hooks) if (h.command.endsWith(script)) return h.timeout;
  return undefined;
};
for (const [event, script] of [["PreToolUse", "file-claim.mjs"], ["PreToolUse", "file-hold.mjs"], ["PreToolUse", "subagent-start.mjs"],
  ["PreToolUse", "ask-sidecar.mjs"], ["PermissionRequest", "ask-sidecar.mjs"]]) {
  const t = declaredTimeout(event, script);
  ok(`hooks.json: ${event} ${script} declares an explicit timeout`, Number.isFinite(t) && t > 0 && t <= 20, String(t));
}
const claimLimitMs = declaredTimeout("PreToolUse", "file-claim.mjs") * 1000;
const holdLimitMs = declaredTimeout("PreToolUse", "file-hold.mjs") * 1000;
const subLimitMs = declaredTimeout("PreToolUse", "subagent-start.mjs") * 1000;

const edit = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(CWD, "a.ts") }, cwd: CWD };
const answers = (r) => r.status === 0 && validJson(r.out) && !JSON.parse(r.out).hookSpecificOutput?.permissionDecision;
{
  const r = await runHook("file-claim.mjs", edit, { RELAY_URL: "http://127.0.0.1:1" });
  ok("file-claim: hub down -> no decision, inside its timeout", answers(r) && r.ms < claimLimitMs / 2, `${r.ms}ms ${r.out}`);
}
{
  const r = await runHook("file-claim.mjs", { ...edit, tool_input: { file_path: join(CWD, "b.ts") } }, { RELAY_URL: HANG });
  ok("file-claim: hub hangs -> no decision, inside its timeout", answers(r) && r.ms < claimLimitMs / 2, `${r.ms}ms ${r.out}`);
}
{
  const r = await runHook("file-claim.mjs", { ...edit, tool_input: { file_path: join(CWD, "c.ts") } },
    { RELAY_URL: HANG, RELAY_CLAIM_TIMEOUT_MS: "60000", RELAY_CLAIM_WATCHDOG_MS: "700" });
  ok("file-claim: the watchdog answers even if the hub call never times out", answers(r) && r.ms < 4000, `${r.ms}ms ${r.out}`);
}
{
  const r = await runHook("file-claim.mjs", null, { RELAY_CLAIM_WATCHDOG_MS: "700" });
  ok("file-claim: stdin never handed over -> still answers", answers(r) && r.ms < 4000, `${r.ms}ms ${r.out}`);
}
{
  const r = await runHook("file-hold.mjs", edit, { RELAY_URL: "http://127.0.0.1:1" });
  ok("file-hold: hub down -> no decision, inside its timeout", answers(r) && r.ms < holdLimitMs / 2, `${r.ms}ms ${r.out}`);
}
{
  const r = await runHook("file-hold.mjs", edit, { RELAY_URL: HANG });
  ok("file-hold: hub hangs -> no decision (never a deny), inside its timeout", answers(r) && r.ms < holdLimitMs - 2000, `${r.ms}ms ${r.out}`);
}
{
  const r = await runHook("file-hold.mjs", edit, { RELAY_URL: HANG, RELAY_HOLD_WATCHDOG_MS: "600" });
  ok("file-hold: the watchdog answers before the hub call gives up", answers(r) && r.ms < 2000, `${r.ms}ms ${r.out}`);
}
{
  const r = await runHook("file-hold.mjs", null);
  ok("file-hold: stdin never handed over -> still answers", answers(r) && r.ms < holdLimitMs / 2, `${r.ms}ms ${r.out}`);
}
{
  const task = { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "x", prompt: "do it" }, session_id: "s", cwd: CWD };
  const down = await runHook("subagent-start.mjs", task, { RELAY_URL: "http://127.0.0.1:1" });
  ok("subagent-start: hub down -> {} inside its timeout", answers(down) && down.ms < subLimitMs / 2, `${down.ms}ms`);
  const slow = await runHook("subagent-start.mjs", task, { RELAY_URL: HANG });
  ok("subagent-start: hub hangs -> {} inside its timeout", answers(slow) && slow.ms < subLimitMs - 2000, `${slow.ms}ms`);
}
for (const s of sockets) s.destroy();

// ═══ 3. transcript rows CC 2.1.300 adds: skipped cheaply, never usage ═══════════════════════════
console.log("# 3. per-request transcript rows");
const asst = (tokens, text = "done") => JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text }], usage: { input_tokens: tokens, cache_read_input_tokens: 0 } } });
// The row's real shape is not documented; this one is the worst plausible case: huge, mentions usage,
// and carries message.usage numbers that must never be read.
const reqRow = (kind = "api_request") => JSON.stringify({ type: kind, system: "s".repeat(200_000), tools: [{ name: "Bash" }], parameters: { max_tokens: 32000 }, message: { usage: { input_tokens: 999_999 } } });
{
  const p = join(W, "t1.jsonl");
  writeFileSync(p, [asst(1500), reqRow(), reqRow("request")].join("\n") + "\n");
  const u = contextUsage(p, {});
  ok("contextUsage: request rows are not counted as usage", u?.tokens === 1500, JSON.stringify(u));
}
{
  // enough request rows after the last assistant row to push it out of the 1.5MB tail
  const p = join(W, "t2.jsonl");
  writeFileSync(p, asst(4321) + "\n");
  for (let i = 0; i < 10; i++) appendFileSync(p, reqRow() + "\n");
  const u = contextUsage(p, {});
  ok("contextUsage: a tail full of request rows widens once and still finds the real reading", u?.tokens === 4321, JSON.stringify(u));
}
{
  const p = join(W, "t3.jsonl");
  writeFileSync(p, [asst(100), JSON.stringify({ type: "system", subtype: "compact_boundary", pad: "p".repeat(100_000) }), asst(50)].join("\n") + "\n");
  ok("contextUsage: a compact_boundary inside a big row is still honored", contextUsage(p, {})?.tokens === 50);
}
{
  const p = join(W, "t4.jsonl");
  writeFileSync(p, [asst(7, "Ship it?"), reqRow(), reqRow()].join("\n") + "\n");
  ok("lastAssistantText: request rows are skipped, the last assistant text wins", lastAssistantText(p) === "Ship it?", lastAssistantText(p));
}

// ═══ 4. PreCompact with an unknown (idle) trigger ═══════════════════════════════════════════════
console.log("# 4. PreCompact on an idle compaction");
{
  const projDir = join(W, "pcproj");
  mkdirSync(projDir, { recursive: true });
  const transcript = join(W, "pc.jsonl");
  writeFileSync(transcript, [JSON.stringify({ type: "user", message: { content: "build the thing" } }), asst(210000, "built")].join("\n") + "\n");
  const env = { CLAUDE_PROJECT_DIR: projDir, RELAY_URL: "http://127.0.0.1:1", TRANTOR_NO_SCROOGE: "1", TRANTOR_NO_HANDOFF_SPAWN: "1" };
  const idle = await runHook("precompact.mjs", { hook_event_name: "PreCompact", session_id: "pc-idle", trigger: "idle", cwd: projDir, transcript_path: transcript }, env, { cwd: projDir });
  ok("precompact: an unknown trigger still writes the handoff", /handoff written: /.test(idle.err) && idle.status === 0 && validJson(idle.out), idle.err.slice(0, 300));
  ok("precompact: ...and says it opened no fresh session", idle.err.includes('trigger "idle" is not auto/manual'), idle.err.slice(0, 300));
  const auto = await runHook("precompact.mjs", { hook_event_name: "PreCompact", session_id: "pc-auto", trigger: "auto", cwd: projDir, transcript_path: transcript }, env, { cwd: projDir });
  ok("precompact: trigger auto keeps its old path", /handoff written: /.test(auto.err) && !auto.err.includes("is not auto/manual"), auto.err.slice(0, 300));
}

// ═══ 5. claude seats pin their permission mode (2.1.285 / 2.1.302 changed -p defaults) ══════════
console.log("# 5. claude -p seat command templates");
{
  const runner = readFileSync(join(ROOT, "bin", "crew-runner.mjs"), "utf8");
  const code = runner.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
  const block = /claude:\s*\{([\s\S]*?)mflag: " --model "/.exec(code)?.[1] ?? "";
  const rows = [...block.matchAll(/(first|next|stateNext):\s*`([^`]*)`/g)].map(m => ({ row: m[1], cmd: m[2] }));
  ok("the claude seat has its three command rows", rows.map(r => r.row).join() === "first,next,stateNext", rows.map(r => r.row).join());
  ok("every claude -p row names --permission-mode bypassPermissions explicitly",
    rows.length === 3 && rows.every(r => r.cmd.includes("-p ") && r.cmd.includes("--permission-mode bypassPermissions")), JSON.stringify(rows));
  ok("...and keeps --dangerously-skip-permissions, so the effective mode is unchanged",
    rows.every(r => r.cmd.includes("--dangerously-skip-permissions")));
}

hub.close(); hang.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
