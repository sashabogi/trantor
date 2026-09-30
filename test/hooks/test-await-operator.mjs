#!/usr/bin/env node
// #9814 — a turn that ENDS on a question to the operator must stamp the session's peer status
// "blocked · awaiting operator" (the app maps "blocked …" to needs-you), clear on the next
// UserPromptSubmit, and never touch a status it did not set. Hook drills run the REAL hook against
// an in-process recorder hub, spawned async so the event loop can answer it (test-hook-routing pattern).
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "../drill-env.mjs";
import { endsWithOperatorQuestion, lastAssistantText } from "../../hooks/lib/await-operator.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const W = mkdtempSync(join(tmpdir(), "trantor-await-op-"));
const BUS = join(W, "bus");
const CWD = join(W, "proj");
mkdirSync(BUS, { recursive: true });
mkdirSync(CWD, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : (extra ? " — " + extra : "")}`);
};

console.log("# trantor await-operator detector drills");

// ---- the question detector: a real question vs a sentence that merely contains a "?" --------
ok("a reply ending in a question is awaiting the operator",
  endsWithOperatorQuestion("All tests green, the build is clean. Ship 0.18.74?"));
ok("trailing whitespace after the '?' still counts",
  endsWithOperatorQuestion("Ship it?  \n"));
ok("a '?' mid-sentence with a statement ending is NOT a question",
  !endsWithOperatorQuestion("Fix the `a?b` regex? Done — shipped and green."));
ok("a question an earlier paragraph asked but the reply went on to answer is NOT awaiting",
  !endsWithOperatorQuestion("Should I ship?\n\nActually — shipped, 0.18.74 is out."));
ok("a rhetorical question closed by a final statement paragraph is NOT awaiting",
  !endsWithOperatorQuestion("Why did it break? A missing guard.\n\nGuard added, tests green."));
ok("empty text is never a question", !endsWithOperatorQuestion("") && !endsWithOperatorQuestion(null));

// ---- lastAssistantText reads the transcript tail ---------------------------------------------
const transcriptOf = (name, entries) => {
  const p = join(W, name);
  writeFileSync(p, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return p;
};
const assistant = (text) => ({ type: "assistant", message: { model: "claude-x", content: [{ type: "text", text }] } });
{
  const p = transcriptOf("t1.jsonl", [
    { type: "user", message: { content: [{ type: "text", text: "do the thing" }] } },
    assistant("Working on it."),
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } },
    assistant("Done. Ship it?"),
  ]);
  ok("the LAST assistant message with text wins over earlier ones and tool-only entries",
    lastAssistantText(p) === "Done. Ship it?", JSON.stringify(lastAssistantText(p)));
  ok("a missing transcript reads as no text", lastAssistantText(join(W, "nope.jsonl")) === "");
  ok("a user-only transcript has no assistant text",
    lastAssistantText(transcriptOf("t2.jsonl", [{ type: "user", message: { content: [{ type: "text", text: "hi" }] } }])) === "");
}

console.log("# trantor await-operator hook drills");

// ---- recorder hub ----------------------------------------------------------------------------
const hits = [];
const hub = http.createServer((req, res) => {
  let b = ""; req.on("data", c => (b += c));
  req.on("end", () => {
    let body = {}; try { body = JSON.parse(b || "{}"); } catch {}
    hits.push({ path: req.url, method: req.method, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, peers: [] }));
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

const SID = "9814drill-0000-0000-0000-0000000000aa";
const stampFile = join(BUS, "await-operator-drillhost_awaitproj.json");

function runHook(payload, extraEnv = {}) {
  hits.length = 0;
  const env = {
    ...drillEnv(), HOME: W, AGENT_BUS_DIR: BUS,
    RELAY_URL: HUB, RELAY_PROJECT: "awaitproj", RELAY_SESSION: "drillhost:awaitproj",
    ...extraEnv,
  };
  return new Promise(resolve => {
    const p = spawn("node", [join(ROOT, "hooks/await-operator.mjs")], { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => (out += d)); p.stderr.on("data", d => (err += d));
    p.on("close", status => setTimeout(() => resolve({ hits: [...hits], out, err, status }), 150));
    p.stdin.end(JSON.stringify(payload));
  });
}
const registers = (r) => r.hits.filter(h => h.path === "/register" && h.method === "POST");

// ---- a prose question stamps blocked ----------------------------------------------------------
{
  const transcript = transcriptOf("q.jsonl", [assistant("Everything is ready — the gate is green.\n\nShip 0.18.74?")]);
  const r = await runHook({ hook_event_name: "Stop", session_id: SID, cwd: CWD, transcript_path: transcript });
  const reg = registers(r);
  ok("Stop on a turn ending in '?' returns no decision and exits clean", r.status === 0 && r.out === "{}", JSON.stringify({ status: r.status, out: r.out, err: r.err.slice(0, 200) }));
  ok("...and stamps the peer status 'blocked · awaiting operator'",
    reg.length === 1 && reg[0].body.status === "blocked · awaiting operator" && reg[0].body.session === "drillhost:awaitproj",
    JSON.stringify(reg.map(h => h.body)));
  ok("...and records the local stamp so only this hook lifts it", existsSync(stampFile));
}

// ---- the next prompt clears it ---------------------------------------------------------------
{
  const r = await runHook({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: CWD, prompt: "yes, ship it" });
  const reg = registers(r);
  ok("the operator's reply restores the idle vocabulary ('active in <project>')",
    reg.length === 1 && reg[0].body.status === "active in awaitproj", JSON.stringify(reg.map(h => h.body)));
  ok("...and the local stamp is gone", !existsSync(stampFile));
}

// ---- a statement containing a '?' stamps nothing ---------------------------------------------
{
  const transcript = transcriptOf("stmt.jsonl", [assistant("The `a?b` glob? Handled. Shipped, gate green.")]);
  const r = await runHook({ hook_event_name: "Stop", session_id: SID, cwd: CWD, transcript_path: transcript });
  ok("a turn ending on a statement posts NO status", registers(r).length === 0, JSON.stringify(registers(r).map(h => h.body)));
  ok("...and leaves no stamp behind", !existsSync(stampFile));
}

// ---- an open relay_ask sidecar stamps even with no prose question -----------------------------
{
  mkdirSync(join(BUS, "asks"), { recursive: true });
  writeFileSync(join(BUS, "asks", `${SID}.json`), JSON.stringify({ session_id: SID, kind: "relay_ask", ask: { question: "which sha?" } }));
  const transcript = transcriptOf("noq.jsonl", [assistant("Asking the assigner now.")]);
  const r = await runHook({ hook_event_name: "Stop", session_id: SID, cwd: CWD, transcript_path: transcript });
  const reg = registers(r);
  ok("a declared ask sidecar still open at Stop stamps blocked",
    reg.length === 1 && reg[0].body.status === "blocked · awaiting operator", JSON.stringify(reg.map(h => h.body)));
  ok("...via the sidecar, recorded on the stamp",
    JSON.parse(readFileSync(stampFile, "utf8")).via === "ask-sidecar");
}

// ---- a later Stop with no question clears a stale stamp (stop-inbox kept the model going) -----
{
  rmSync(join(BUS, "asks", `${SID}.json`), { force: true });   // the answer landed; the sidecar closed
  const transcript = transcriptOf("moved.jsonl", [assistant("Inbox handled, nothing left. All quiet.")]);
  const r = await runHook({ hook_event_name: "Stop", session_id: SID, cwd: CWD, transcript_path: transcript });
  const reg = registers(r);
  ok("a convergent Stop whose turn does NOT end on a question lifts the stamp",
    reg.length === 1 && reg[0].body.status === "active in awaitproj" && !existsSync(stampFile),
    JSON.stringify(reg.map(h => h.body)));
}

// ---- a prompt with no stamp touches nothing ---------------------------------------------------
{
  const r = await runHook({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: CWD, prompt: "just a prompt" });
  ok("UserPromptSubmit with no stamp of ours posts nothing (a runner's 'blocked' is not ours to lift)",
    registers(r).length === 0, JSON.stringify(registers(r).map(h => h.body)));
}

// ---- crew seats are the runner's vocabulary, never stamped from here --------------------------
{
  const transcript = transcriptOf("seat.jsonl", [assistant("Ship it?")]);
  const r = await runHook({ hook_event_name: "Stop", session_id: SID, cwd: CWD, transcript_path: transcript }, { TRANTOR_SEAT: "kimi" });
  ok("a crew seat (TRANTOR_SEAT) is never stamped — the runner owns its status",
    registers(r).length === 0 && !existsSync(stampFile), JSON.stringify(registers(r).map(h => h.body)));
}

// ---- malformed input fails open ----------------------------------------------------------------
{
  const r = await new Promise(resolve => {
    const env = { ...drillEnv(), HOME: W, AGENT_BUS_DIR: BUS, RELAY_URL: HUB, RELAY_PROJECT: "awaitproj", RELAY_SESSION: "drillhost:awaitproj" };
    const p = spawn("node", [join(ROOT, "hooks/await-operator.mjs")], { cwd: CWD, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", d => (out += d));
    p.on("close", status => resolve({ status, out }));
    p.stdin.end("not json");
  });
  ok("malformed stdin fails open with '{}' and exit 0", r.status === 0 && r.out === "{}");
}

// ---- wiring ------------------------------------------------------------------------------------
{
  const hooks = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8")).hooks;
  const commands = event => (hooks[event] ?? []).flatMap(group => group.hooks.map(h => h.command));
  ok("Stop registers the await-operator hook",
    commands("Stop").includes("node ${CLAUDE_PLUGIN_ROOT}/hooks/await-operator.mjs"));
  ok("...and it runs AFTER the ask-sidecar close, so a surviving sidecar is an open relay_ask",
    commands("Stop").indexOf("node ${CLAUDE_PLUGIN_ROOT}/hooks/await-operator.mjs") >
    commands("Stop").indexOf("node ${CLAUDE_PLUGIN_ROOT}/hooks/ask-sidecar.mjs"));
  ok("UserPromptSubmit registers the await-operator clear",
    commands("UserPromptSubmit").includes("node ${CLAUDE_PLUGIN_ROOT}/hooks/await-operator.mjs"));
}

hub.close();
rmSync(W, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
