#!/usr/bin/env node
// test-kimi-events — P3 of docs/KIMI-BRIDGE-CONTRACT.md (#4786): the PROOF.
// Every event in kimi.plugin.json, fed a realistic KIMI-dialect payload, through the REAL bridge
// (kimi/bridge.mjs, P1 #4784) against a hermetic spawned hub with RELAY_AUTH=enforce:
//   • the hub effect (register/focus/card/heartbeat/handoff-ping/todo) lands SIGNED — an enforce
//     hub 401s unsigned writes, so the effect existing IS the signature proof;
//   • output translation: SessionStart context STASHED (never printed), first UserPromptSubmit
//     FLUSHES the stash as plain text then clears it, PostToolUse context prints as PLAIN stdout;
//   • stdout is never a CC JSON envelope / never JSON garbage into kimi's context.
// Isolation: random port, temp HOME/AGENT_BUS_DIR/RELAY_DATA_DIR — never :4477 or real ~/.agent-bus.
// KIMI_TEST_BRIDGE overrides the bridge path for pre-P1 validation ONLY; default is the real bridge.
// Package: test-kimi-events.mjs (owned by #4786 only).
import { spawn, spawnSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.KIMI_TEST_BRIDGE || join(ROOT, "kimi", "bridge.mjs");
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? ` — ${e}` : ""}`); } };

function mDir(pfx) { return mkdtempSync(join(tmpdir(), `${pfx}-${process.pid}-${randomBytes(3).toString("hex")}-`)); }
let HUB = null;

async function startHub() {
  const dir = mDir("ke-hub");
  mkdirSync(join(dir, ".agent-bus"), { recursive: true });
  // LISTEN 0, never a fixed or even a picked-random port: parallel suites each spawning hubs
  // can collide by chance and false-fail a green build. RELAY_PORT=0 → the OS assigns an
  // ephemeral port, announced on stderr ("[trantor] hub on http://127.0.0.1:<port>"), which
  // we parse below. Collision-free by construction.
  const env = {
    ...process.env,
    HOME: dir, AGENT_BUS_DIR: join(dir, ".agent-bus"), RELAY_DATA_DIR: dir,
    RELAY_PORT: "0", RELAY_HOST: "127.0.0.1",
    RELAY_AUTH: "enforce", RELAY_ENROLL: "tofu",
    RELAY_ONLINE_MS: "1500", RELAY_PEER_TTL_MS: "3000", RELAY_EVENT_CAP: "300",
    TRANTOR_NO_UPDATE_CHECK: "1",
  };
  delete env.RELAY_URL; delete env.RELAY_SESSION; delete env.RELAY_PROJECT; delete env.RELAY_HOST_ID; delete env.CLAUDE_PROJECT_DIR;
  const child = spawn(process.execPath, [join(ROOT, "hub.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let er = "";
  child.stderr.on("data", d => { er += d.toString(); });
  // The hub's own announcement prints the ENV port ("…:0"), not the assigned one (hub.mjs:2304 —
  // reported; not this card's file). Discover the REAL listening port from the child itself.
  const portByLsof = () => {
    try {
      const out = execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${child.pid} -Fn 2>/dev/null`, { encoding: "utf8", timeout: 3000 });
      const m = out.match(/n127\.0\.0\.1:(\d+)/) || out.match(/n\*:(\d+)/) || out.match(/n:(\d+)/);
      return m ? Number(m[1]) : 0;
    } catch { return 0; }
  };
  let port = 0;
  for (let i = 0; i < 60 && !port; i++) { port = portByLsof(); if (!port) await sleep(150); }
  if (!port) {
    try { child.kill(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    throw new Error(`hub (listen 0) never got a port err=${er.slice(-500)}`);
  }
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) });
      if (r.ok) return { child, dir, port, base: `http://127.0.0.1:${port}`, err: () => er };
    } catch {}
    await sleep(80);
  }
  try { child.kill(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  throw new Error(`hub :${port} no health err=${er.slice(-500)}`);
}
function stopHub() { if (HUB) { try { HUB.child.kill(); } catch {} try { rmSync(HUB.dir, { recursive: true, force: true }); } catch {} HUB = null; } }

// Signed hub client for the test's OWN reads/writes (owner identity), per test-identity.mjs.
const { generate, signRequest, HDR } = await import(join(ROOT, "lib", "identity.mjs"));
function signHdr(id, method, path, body) {
  const b = body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
  return signRequest({ pubkey: id.pubkey, privkey: id.privkey }, { method, path, body: b });
}
async function sFetch(id, method, path, bodyObj) {
  const body = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  const r = await fetch(HUB.base + path, { method, headers: { "content-type": "application/json", ...signHdr(id, method, path, body) }, body });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { _raw: txt.slice(0, 400) }; }
  return { status: r.status, json: j };
}

// ── the kimi seat: temp HOME, project dir, bridge runner ─────────────────────
const SEAT = mDir("ke-seat");
const BUS = join(SEAT, ".agent-bus");
const PROJ_DIR = mDir("ke-proj");
const PROJ = basename(PROJ_DIR);
const AGENT = "kimi-orch";                       // RELAY_AGENT, exactly as kimi.plugin.json sets it
const SESSION = `${AGENT}:${PROJ}`;              // what the canonical hooks derive + register as
const SID = "kimi-sess-0001";                    // kimi harness session id (CC session_id)

// Ambient detached workers heartbeat would spawn on a fresh HOME (summarize/narrate) — pre-stamp
// them so the test stays hermetic (no LLM, no network beyond the local hub).
mkdirSync(BUS, { recursive: true });
writeFileSync(join(BUS, "summarize.stamp"), String(Date.now()));
writeFileSync(join(BUS, "narrate.stamp"), String(Date.now()));

function bridgeEnv() {
  const env = {
    ...process.env,
    HOME: SEAT, AGENT_BUS_DIR: BUS,
    RELAY_URL: HUB.base, RELAY_AGENT: AGENT,
    TRANTOR_NO_UPDATE_CHECK: "1", TRANTOR_NO_BALANCE_CHECK: "1",
    TRANTOR_NO_SCROOGE_TITLES: "1", TRANTOR_NO_HANDOFF_SPAWN: "1",
    RELAY_INBOX_POLL_MS: "0",                     // allow back-to-back inbox-deliver runs without the 4s throttle
  };
  delete env.RELAY_SESSION; delete env.RELAY_PROJECT; delete env.RELAY_HOST_ID; delete env.CLAUDE_PROJECT_DIR;
  return env;
}

// Run ONE kimi event through the REAL bridge: `node kimi/bridge.mjs <event> <canonical-hook>`.
function runBridge(event, hookFile, payload) {
  return spawnSync(process.execPath, [BRIDGE, event, join(ROOT, "hooks", hookFile)], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 40000, env: bridgeEnv(), cwd: SEAT,
  });
}

// A CC JSON envelope (or any JSON object) on stdout = JSON garbage into kimi's context. Forbidden.
function jsonGarble(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  if (t.includes("hookSpecificOutput") || t.includes("systemMessage")) return true;
  try { const j = JSON.parse(t); return j && typeof j === "object"; } catch { return false; }
}
function stashes() {
  try { return readdirSync(BUS).filter(f => f.startsWith("kimi-stash-") && f.endsWith(".txt")); } catch { return []; }
}
function stashText() {
  return stashes().map(f => { try { return readFileSync(join(BUS, f), "utf8"); } catch { return ""; } }).join("\n");
}
async function tasks() {
  const r = await sFetch(OWNER, "GET", `/tasks?project=${encodeURIComponent(PROJ)}`, undefined);
  return (r.json && Array.isArray(r.json.tasks)) ? r.json.tasks : [];
}
async function peers() {
  const r = await sFetch(OWNER, "GET", "/peers", undefined);
  return (r.json && Array.isArray(r.json.peers)) ? r.json.peers : [];
}
let OWNER = null;
const OWNER_NAME = "ke-owner";

try {
  console.log("\n# test-kimi-events — P3 proof: every kimi.plugin.json event through the REAL bridge vs an ENFORCE hub");

  console.log("\n[0] bridge present (P1 #4784):");
  if (!existsSync(BRIDGE)) {
    console.log(`  ✗ kimi/bridge.mjs missing — P1 #4784 has not landed; nothing to prove yet (looked: ${BRIDGE})`);
    console.log(`\ntest-kimi-events: 0 passed, 1 failed`);
    process.exit(1);
  }
  ok(`bridge exists at ${BRIDGE.replace(ROOT + "/", "")}`, true);

  HUB = await startHub();
  OWNER = generate();
  const er = await sFetch(OWNER, "POST", "/enroll", { name: OWNER_NAME, kind: "human", scopes: [{ project: "*", role: "owner" }] });
  ok("owner enrolled (TOFU, scopes *)", er.status < 400, `status ${er.status}`);
  const unsigned = await fetch(HUB.base + "/tasks");   // the premise of the whole proof: enforce rejects unsigned
  ok("enforce hub rejects unsigned reads (401)", unsigned.status === 401, `got ${unsigned.status}`);

  // A seeded board card so SessionStart's catch-up context is non-empty → the stash has real content.
  await sFetch(OWNER, "POST", "/task", { project: PROJ, title: "seed: kimi bridge proof card", status: "todo", by: OWNER_NAME });

  console.log("\n[1] SessionStart (manifest: kimi/hooks/sessionstart.mjs → hooks/sessionstart.mjs):");
  {
    const r = runBridge("SessionStart", "sessionstart.mjs", {
      hook_event_name: "SessionStart", source: "startup", session_id: SID, cwd: PROJ_DIR, transcript_path: "",
    });
    ok("exit 0", r.status === 0, `status ${r.status} stderr ${String(r.stderr).slice(0, 200)}`);
    ok("stdout is not a CC JSON envelope (context must be STASHED, not printed)", !jsonGarble(r.stdout), JSON.stringify(String(r.stdout).slice(0, 120)));
    ok("stash file created under the seat's ~/.agent-bus", stashes().length > 0, `found ${stashes().length}`);
    ok("stash carries the catch-up context (seed card visible)", stashText().includes("seed: kimi bridge proof card"), stashText().slice(0, 120));
    const ps = await peers();
    const me = ps.find(p => p.session === SESSION);
    ok("SIGNED /register landed: peer row exists", !!me, `sessions: ${ps.map(p => p.session).join(",") || "(none)"}`);
    ok("peer registered with status from the canonical hook", !!me && String(me.status).includes(`active in ${PROJ}`), me?.status || "");
  }

  console.log("\n[2] UserPromptSubmit — FIRST prompt (flush pending stash; kimi array-parts prompt):");
  {
    const r = runBridge("UserPromptSubmit", "prompt-focus.mjs", {
      hook_event_name: "UserPromptSubmit", session_id: SID, cwd: PROJ_DIR,
      prompt: [{ type: "text", text: "Fix the login redirect bug in the auth module" }],   // live-captured kimi 0.34.0 shape
    });
    ok("exit 0", r.status === 0, `status ${r.status} stderr ${String(r.stderr).slice(0, 200)}`);
    ok("stdout FLUSHES the stash as plain text (seed card surfaced)", String(r.stdout).includes("seed: kimi bridge proof card"), JSON.stringify(String(r.stdout).slice(0, 160)));
    ok("stdout is plain text, never a CC envelope", !jsonGarble(r.stdout), JSON.stringify(String(r.stdout).slice(0, 120)));
    ok("stash cleared after flush", stashes().length === 0, `${stashes().length} stash file(s) remain`);
    const ts = await tasks();
    const f = ts.find(t => t.source === "session");
    ok("SIGNED /focus landed: focus card doing", !!f && f.status === "doing", JSON.stringify(ts.map(t => `${t.source}:${t.title}:${t.status}`)));
    ok("focus title = translated prompt text", !!f && f.title === "Fix the login redirect bug in the auth module", f?.title || "");
    ok("focus card keyed by kimi session_id (cc)", !!f && f.cc === SID, f?.cc || "(no cc)");
  }

  console.log("\n[2b] UserPromptSubmit — second prompt (user_prompt string alias; re-focus, no stash replay):");
  {
    const r = runBridge("UserPromptSubmit", "prompt-focus.mjs", {
      hook_event_name: "UserPromptSubmit", session_id: SID, cwd: PROJ_DIR,
      user_prompt: "add coverage for the stash flush path",
    });
    ok("exit 0", r.status === 0, `status ${r.status}`);
    ok("no stash content replayed (already flushed)", !String(r.stdout).includes("seed: kimi bridge proof card"), JSON.stringify(String(r.stdout).slice(0, 120)));
    ok("stdout clean (no JSON garble)", !jsonGarble(r.stdout));
    const ts = await tasks();
    const f = ts.find(t => t.source === "session");
    ok("rolling focus card re-titled by alias prompt", !!f && f.title === "add coverage for the stash flush path", f?.title || "");
  }

  console.log("\n[3] PreToolUse Agent|AgentSwarm (kimi's sub-agent dispatch):");
  {
    const r = runBridge("PreToolUse", "subagent-start.mjs", {
      hook_event_name: "PreToolUse", tool_name: "Agent", session_id: SID, cwd: PROJ_DIR,
      tool_input: { subagent_type: "general-purpose", prompt: "Research the kimi bridge contract" },
    });
    ok("exit 0", r.status === 0, `status ${r.status}`);
    ok("stdout suppressed", !jsonGarble(r.stdout), JSON.stringify(String(r.stdout).slice(0, 120)));
    const ts = await tasks();
    const c = ts.find(t => t.source === "cc-subagent" && t.status === "doing");
    ok("SIGNED /task landed: in-flight sub-agent card doing", !!c, JSON.stringify(ts.filter(t => t.source === "cc-subagent").map(t => `${t.status}:${t.title}`)));
    ok("card titled from tool_input", !!c && c.title === "general-purpose: Research the kimi bridge contract", c?.title || "");
  }

  console.log("\n[4] SubagentStart (enrich the in-flight card with agent_id):");
  {
    const r = runBridge("SubagentStart", "subagent-start.mjs", {
      hook_event_name: "SubagentStart", session_id: SID, cwd: PROJ_DIR,
      agent_id: "agent-kmtest01", agent_type: "general-purpose", parent_session_id: SID,
    });
    ok("exit 0", r.status === 0, `status ${r.status}`);
    ok("stdout suppressed", !jsonGarble(r.stdout));
    const ts = await tasks();
    const c = ts.find(t => t.source === "cc-subagent");
    ok("SIGNED enrich landed: card carries agent_id", !!c && (c._aid === "agent-kmtest01" || c.agentId === "agent-kmtest01"), JSON.stringify(c ? { _aid: c._aid, agentId: c.agentId } : null));
    ok("card nested under the kimi session (parent)", !!c && c.parent === SID, c?.parent || "(none)");
  }

  console.log("\n[5] PostToolUse → heartbeat (presence refresh):");
  {
    const r = runBridge("PostToolUse", "heartbeat.mjs", {
      hook_event_name: "PostToolUse", tool_name: "Write", session_id: SID, cwd: PROJ_DIR, transcript_path: "",
    });
    ok("exit 0", r.status === 0, `status ${r.status} stderr ${String(r.stderr).slice(0, 200)}`);
    ok("stdout suppressed", !jsonGarble(r.stdout));
    const ps = await peers();
    const me = ps.find(p => p.session === SESSION);
    ok("SIGNED /register refresh landed (peer alive)", !!me, "peer row gone");
    // integration fix: the canonical heartbeat now derives llm from RELAY_AGENT (kimi-orch -> kimi)
    // instead of hard-coding claude — a kimi session must not wear a claude chip on the board.
    ok("heartbeat stamped llm=kimi on the peer (brand from RELAY_AGENT)", !!me && me.llm === "kimi", me?.llm || "(none)");
    ok("heartbeat stamped hookVersion on the peer", !!me && !!me.hookVersion, me?.hookVersion || "(none)");
  }

  console.log("\n[6] PostToolUse → inbox-deliver (DM delivered as PLAIN stdout):");
  {
    const payload = {
      hook_event_name: "PostToolUse", tool_name: "Write", session_id: SID, cwd: PROJ_DIR,
      tool_input: { file_path: "/tmp/ke-write.txt", content: "x" },
    };
    const r1 = runBridge("PostToolUse", "inbox-deliver.mjs", payload);
    ok("run 1 (cursor init) exit 0, no output", r1.status === 0 && !jsonGarble(r1.stdout), `status ${r1.status} out ${JSON.stringify(String(r1.stdout).slice(0, 80))}`);
    const dm = await sFetch(OWNER, "POST", "/send", { from: OWNER_NAME, to: SESSION, text: "direct ping for kimi bridge proof", project: PROJ });
    ok("peer DM enqueued (signed)", dm.status < 400, `status ${dm.status}`);
    const r2 = runBridge("PostToolUse", "inbox-deliver.mjs", payload);
    ok("run 2 exit 0", r2.status === 0, `status ${r2.status}`);
    ok("DM surfaced as PLAIN STDOUT text", String(r2.stdout).includes("direct ping for kimi bridge proof"), JSON.stringify(String(r2.stdout).slice(0, 200)));
    ok("stdout is not a CC envelope / not JSON", !jsonGarble(r2.stdout), JSON.stringify(String(r2.stdout).slice(0, 120)));
  }

  console.log("\n[7] PostToolUse TodoList (kimi tool name; canonical hook expects TodoWrite):");
  {
    const r = runBridge("PostToolUse", "todo-sync.mjs", {
      hook_event_name: "PostToolUse", tool_name: "TodoList", session_id: SID, cwd: PROJ_DIR,
      tool_input: { todos: [
        { content: "kimi bridge: write the proof test", status: "in_progress" },
        { content: "kimi bridge: run it green", status: "pending" },
      ] },
    });
    ok("exit 0", r.status === 0, `status ${r.status} stderr ${String(r.stderr).slice(0, 200)}`);
    ok("stdout suppressed", !jsonGarble(r.stdout));
    const ts = await tasks();
    const todo = ts.find(t => t.source === "todo" && t.title === "kimi bridge: write the proof test");
    const pend = ts.find(t => t.source === "todo" && t.title === "kimi bridge: run it green");
    ok("SIGNED /todos landed: in_progress → doing card", !!todo && todo.status === "doing", JSON.stringify(ts.filter(t => t.source === "todo").map(t => `${t.title}:${t.status}`)));
    ok("pending → todo card", !!pend && pend.status === "todo");
    ok("todo cards assigned to the kimi session", !!todo && todo.assignee === SESSION, todo?.assignee || "");
  }

  console.log("\n[8] PreCompact (handoff written + signed bus ping; NO dialog spawn):");
  {
    const r = runBridge("PreCompact", "precompact.mjs", {
      hook_event_name: "PreCompact", session_id: SID, cwd: PROJ_DIR, transcript_path: "", trigger: "auto",
    });
    ok("exit 0", r.status === 0, `status ${r.status} stderr ${String(r.stderr).slice(0, 200)}`);
    ok("stdout suppressed (no envelope)", !jsonGarble(r.stdout));
    let handoff = "";
    try { handoff = readdirSync(join(BUS, "handoffs")).find(f => new RegExp(`^${PROJ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.json$`).test(f)) || ""; } catch {}
    ok("handoff file written for this project", !!handoff, `handoffs/: ${(() => { try { return readdirSync(join(BUS, "handoffs")).join(",") || "(empty)"; } catch { return "(none)"; } })()}`);
    const ev = await sFetch(OWNER, "GET", `/events?type=message&project=${encodeURIComponent(PROJ)}`, undefined);
    ok("SIGNED bus ping landed (Handoff ready broadcast)", JSON.stringify(ev.json).includes("Handoff ready for"), JSON.stringify(ev.json).slice(0, 160));
  }

  console.log("\n[9] Notification (background agent needs input → blocked card):");
  {
    const r = runBridge("Notification", "agent-notify.mjs", {
      hook_event_name: "Notification", session_id: SID, cwd: PROJ_DIR,
      notification_type: "agent_needs_input", message: "background agent needs input",
      agent_id: "bg-kmtest-1", agent_type: "background", parent_session_id: SID,
    });
    ok("exit 0", r.status === 0, `status ${r.status}`);
    ok("stdout suppressed", !jsonGarble(r.stdout));
    const ts = await tasks();
    const bg = ts.find(t => t.source === "cc-bg-agent");
    ok("SIGNED /task landed: bg-agent card BLOCKED", !!bg && bg.status === "blocked", JSON.stringify(ts.filter(t => t.source === "cc-bg-agent").map(t => `${t.status}:${t.title}`)));
    ok("bg card keyed by agent id", !!bg && (bg._aid === "bg-kmtest-1" || bg.agentId === "bg-kmtest-1"), bg?._aid || "(none)");
  }

  console.log("\n[10] SubagentStop (cost card done; additionalContext SUPPRESSED for this event):");
  {
    const fakeSub = join(SEAT, "subagents", "agent-kmtest01.jsonl");
    mkdirSync(dirname(fakeSub), { recursive: true });
    writeFileSync(fakeSub, [
      JSON.stringify({ type: "user", message: { content: "Research the kimi bridge contract" } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 120, output_tokens: 80 } } }),
    ].join("\n"));
    const r = runBridge("SubagentStop", "subagent-cost.mjs", {
      hook_event_name: "SubagentStop", session_id: SID, cwd: PROJ_DIR,
      agent_id: "agent-kmtest01", agent_type: "general-purpose", parent_session_id: SID, transcript_path: fakeSub,
    });
    ok("exit 0", r.status === 0, `status ${r.status} stderr ${String(r.stderr).slice(0, 200)}`);
    ok("no CC envelope on stdout (SupagentStop context is not a print event)", !jsonGarble(r.stdout), JSON.stringify(String(r.stdout).slice(0, 120)));
    const ts = await tasks();
    const c = ts.find(t => t.source === "cc-subagent" && (t._aid === "agent-kmtest01" || t.agentId === "agent-kmtest01"));
    ok("SIGNED /task landed: sub-agent card flipped DONE", !!c && c.status === "done", JSON.stringify(ts.filter(t => t.source === "cc-subagent").map(t => `${t.status}:${t.title}`)));
    ok("cost recorded (priced or explicitly unpriced)", !!c && (typeof c.costUsd === "number" || String(c.costNote || "").includes("unpriced")), JSON.stringify(c ? { costUsd: c.costUsd, costNote: c.costNote } : null));
  }

  console.log(`\ntest-kimi-events: ${pass} passed, ${fail} failed`);
  stopHub();
  try { rmSync(SEAT, { recursive: true, force: true }); } catch {}
  try { rmSync(PROJ_DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error(`harness error: ${e.stack || e}`);
  stopHub();
  try { rmSync(SEAT, { recursive: true, force: true }); } catch {}
  try { rmSync(PROJ_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
