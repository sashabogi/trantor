#!/usr/bin/env node
// trantor inbox-delivery tests — the busy-session bug fix (2026-06-23).
//
// Bug: bus delivery is pull-on-demand, so a session busy in a tool loop never polls and never
// sees a peer's relay_send (observed: a mid-build sibling ignored two pings over 10 min). The
// fix is hooks/inbox-deliver.mjs: a PostToolUse hook that polls /inbox and injects new messages
// via hookSpecificOutput.additionalContext. These tests run the REAL hook as a subprocess against
// an in-memory mock hub (matching the real /send + /inbox contract) and assert:
//   1. first run initialises the cursor to "now" and injects NOTHING (no backlog flood),
//   2. a later DIRECT message is injected as additionalContext,
//   3. the cursor advances so the same message is not re-injected,
//   4. a session never receives its OWN message (from === session is filtered).
// Hermetic: HOME points at a temp dir (stamps land there), RELAY_URL points at the mock hub.
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const pexec = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
console.log("# trantor inbox-delivery tests");

// --- in-memory mock hub: the slice of the real hub the hook talks to ---
let seq = 0;
const messages = [];
const deliverable = (m, s) => (m.to === s || m.to === "all") && m.from !== s;
const body = req => new Promise(res => { let d = ""; req.on("data", c => (d += c)); req.on("end", () => { try { res(JSON.parse(d || "{}")); } catch { res({}); } }); });
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "POST" && u.pathname === "/send") {
    const b = await body(req);
    const msg = { id: ++seq, ts: Date.now(), from: b.from || "anon", to: b.to || "all", text: String(b.text ?? "") };
    messages.push(msg);
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, id: msg.id })); return;
  }
  if (req.method === "GET" && u.pathname === "/inbox") {
    const session = u.searchParams.get("session"); const since = Number(u.searchParams.get("since") || 0);
    const msgs = messages.filter(m => m.id > since && deliverable(m, session));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: msgs, cursor: msgs.length ? msgs[msgs.length - 1].id : since })); return;
  }
  res.writeHead(404); res.end("{}");
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

// Temp HOME so the hook's stamp/cursor files are isolated (homedir() honours $HOME).
const home = join(tmpdir(), "trantor-inbox-" + process.pid);
mkdirSync(join(home, ".agent-bus"), { recursive: true });
const SESSION = "tester:proj";

const hook = join(HERE, "hooks", "inbox-deliver.mjs");
// Run the hook exactly as Claude Code would (tool-input JSON on stdin), throttle disabled so each
// invocation actually polls. MUST be async (execFile, not execFileSync): the mock hub runs in THIS
// process, so a synchronous child would block our event loop and the hook's /inbox fetch would
// deadlock. Returns parsed stdout JSON.
const run = async () => {
  const child = pexec("node", [hook], {
    env: { ...process.env, HOME: home, RELAY_URL: url, RELAY_SESSION: SESSION, RELAY_INBOX_POLL_MS: "0" },
    encoding: "utf8",
  });
  child.child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command: "x" } }));
  const { stdout } = await child;
  try { return JSON.parse((stdout || "{}").trim() || "{}"); } catch { return { __raw: stdout }; }
};
// Post straight into the in-process store (what POST /send does) — no blocking curl.
const post = (from, to, text) => { messages.push({ id: ++seq, ts: Date.now(), from, to, text: String(text ?? "") }); };
const ctxOf = o => o?.hookSpecificOutput?.additionalContext || "";

try {
  // Seed some pre-existing backlog the fresh session must NOT be flooded with.
  post("someone:proj", "all", "old broadcast 1");
  post("someone:proj", SESSION, "old direct you should NOT see (arrived before you started listening)");

  // 1. First run: initialise cursor to now, inject nothing.
  const first = await run();
  ok("first run emits empty (no backlog flood)", Object.keys(first).length === 0);

  // 2. A new DIRECT message after init is delivered.
  post("sibling:proj", SESSION, "are you done with the build?");
  const second = await run();
  ok("new direct message injected as additionalContext", ctxOf(second).includes("are you done with the build?"));
  ok("injected context is tagged DIRECT", ctxOf(second).includes("DIRECT") && ctxOf(second).includes("sibling:proj"));
  ok("backlog (pre-init direct) is NOT replayed", !ctxOf(second).includes("should NOT see"));
  ok("emits a valid PostToolUse hookSpecificOutput", second?.hookSpecificOutput?.hookEventName === "PostToolUse");

  // 3. Cursor advanced — the same message is not re-injected.
  const third = await run();
  ok("cursor advances; message not re-delivered", Object.keys(third).length === 0);

  // 4. A session never receives its OWN message.
  post(SESSION, "all", "my own broadcast");
  const fourth = await run();
  ok("own message is not delivered back to self", Object.keys(fourth).length === 0);

  // 5. A broadcast from a peer IS delivered (tagged broadcast).
  post("peer2:proj", "all", "anyone around?");
  const fifth = await run();
  ok("peer broadcast delivered and tagged broadcast", ctxOf(fifth).includes("anyone around?") && ctxOf(fifth).includes("broadcast"));
} finally {
  server.close();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
