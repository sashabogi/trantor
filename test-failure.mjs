#!/usr/bin/env node
// trantor crew failure-visibility drill — proves a failed crew turn is surfaced to the bus
// in real time (the orchestrator was previously blind: the runner swallowed the exit code).
// Hermetic: a mock recording hub (never touches the real ~/.agent-bus/bus.json) + a fake CLI
// that fails like an exhausted account. Exercises the REAL bin/crew-runner.mjs.
// Shares NO state with sibling suites (#6084 audit): the mock hub listens on an EPHEMERAL
// port (listen(0), never a fixed one) and every drill works in its own mkdtempSync directory,
// so test-crew-completion / test-contracts running before it cannot collide with it.
// NOTE on `npm test`: it chains suites with &&, so the first red suite hides every later one —
// a failure in THIS file means the suites before it were green, and a failure BEFORE it means
// this file never ran in that invocation.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "./drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("# trantor crew failure-visibility drill");

// ---- mock hub: record /register + /send, answer the runner's polls -------------------
const registers = [], sends = [];
let inboxQueue = [];
let stallReleaseFile = "";
const hub = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/register") { try { registers.push(JSON.parse(buf)); } catch {} return reply({ ok: true, session: "x", peers: [] }); }
    if (req.method === "POST" && P === "/send") {
      try {
        const message = JSON.parse(buf);
        sends.push(message);
        if (stallReleaseFile && /STALLED/.test(message.text || "")) writeFileSync(stallReleaseFile, "reported\n");
      } catch {}
      return reply({ ok: true, id: sends.length });
    }
    // A drill can PRIME the inbox so the seat takes more than one turn. Without this the runner
    // only ever runs its kickoff, which is why repeated-failure behaviour was untestable.
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    // The runner WAKES on /poll, not /inbox — the long-poll the main loop sits in. Serving only
    // /inbox is why repeated-failure behaviour could not be drilled at all: the seat took its
    // kickoff turn and then waited forever on an endpoint the mock did not answer.
    if (P === "/poll") {
      const m = inboxQueue.splice(0, 1);
      return reply({ messages: m, cursor: (Number(u.searchParams.get("since")) || 0) + m.length });
    }
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/poll") return setTimeout(() => reply({ messages: [], cursor: 0 }), 200);
    return reply({ ok: true });
  });
});
await new Promise((r) => hub.listen(0, "127.0.0.1", r));
const PORT = hub.address().port;
const HUB = `http://127.0.0.1:${PORT}`;

// ---- drill harness: a fake CLI that fails, driven by the REAL runner -----------------
// `script` is the whole body of the fake CLI, so a drill controls exactly WHICH STREAM the
// CLI complains on — the distinction that hid a real outage (see the claude drills below).
async function drill(agent, script, opts = {}) {
  registers.length = 0; sends.length = 0;
  // Inbox fixtures are explicit records; #5760's legs set `from` to speak as hub:duty.
  inboxQueue = (opts.inbox || []).map((m, i) => {
    return { id: i + 1, from: m.from || "host:drill", to: `${agent}:tt-fail-${agent}`, text: m.text, project: `tt-fail-${agent}` };
  });
  const work = mkdtempSync(join(tmpdir(), `tt-fail-${agent}-`));
  stallReleaseFile = opts.releaseOnStall ? join(work, "stall-reported") : "";
  const fakebin = join(work, "bin");
  mkdirSync(fakebin, { recursive: true });
  // opts.fakeName: the executable name the runner actually invokes, when it differs from the
  // agent label (a BYOM seat like `inception` rides the opencode CLI fallback).
  const fake = join(fakebin, opts.fakeName || agent);
  writeFileSync(fake, script);
  chmodSync(fake, 0o755);

  const HOME = join(work, "home");
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  const runner = spawn("node", ["bin/crew-runner.mjs", agent, work], {
    cwd: process.cwd(),
    env: { ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
           RELAY_URL: HUB, RELAY_AGENT: agent, RELAY_PROJECT: `tt-fail-${agent}`,
           CREW_KICKOFF: "say hi and end your turn",
           TRANTOR_TEST_STALL_RELEASE_FILE: stallReleaseFile,
           ...(opts.env || {}) },
    stdio: "ignore",
  });
  // kickoff turn runs synchronously inside the runner; give it a moment to fail + report.
  // #6084: a drill may instead wait for a CONDITION with a deadline. A fixed sleep measures
  // the machine's load, not the behaviour — under load the streak had not finished when the
  // kill landed and the DOWN count came back 0. `until` waits for the event itself;
  // `settleUntil` then waits for proof the streak CONTINUED past it, so an "exactly once"
  // assertion tests the dedup, not a race the drill happened to win.
  const waitStart = Date.now();
  if (opts.until) {
    while (!opts.until(sends) && Date.now() - waitStart < (opts.deadlineMs ?? 30000)) await sleep(100);
  } else {
    await sleep(opts.waitMs ?? 2500);
  }
  if (opts.settleUntil) {
    while (!opts.settleUntil(sends, registers) && Date.now() - waitStart < (opts.settleDeadlineMs ?? 30000)) await sleep(100);
  }
  // #6084: under machine load even the fixed waits can end mid-turn — every drill asserts on
  // bus TRAFFIC, so extend the wait until that traffic goes quiet (no new sends or
  // registrations for 800ms), bounded so a hung runner still ends the drill. A drill whose own
  // subject keeps the bus busy (drill 6's 1.5s retry ladder) opts out: quietDeadlineMs: 0.
  const quietCap = opts.quietDeadlineMs ?? 8000;
  if (quietCap > 0) {
    const quietStart = Date.now();
    let last = -1, quietSince = quietStart;
    while (Date.now() - quietStart < quietCap) {
      const n = sends.length + registers.length;
      if (n !== last) { last = n; quietSince = Date.now(); }
      if (Date.now() - quietSince >= 800) break;
      await sleep(100);
    }
  }
  runner.kill("SIGKILL");
  await sleep(150);
  stallReleaseFile = "";
  const errText = (() => {
    try { return readFileSync(join(HOME, ".agent-bus", `err-${agent}-tt-fail-${agent}.txt`), "utf8"); } catch { return ""; }
  })();
  return { registers: [...registers], sends: [...sends], errText, home: HOME };
}

// ---- drill 1: an exhausted account complaining on STDERR ------------------------------
{
  const { registers, sends } = await drill("codex",
    '#!/bin/sh\necho "Error: insufficient_quota — you exceeded your current quota, please check your plan" >&2\nexit 1\n');
  const failMsg = sends.find((m) => /turn FAILED/i.test(m.text || ""));
  ok("a failure message was posted to the bus (orchestrator is no longer blind)", !!failMsg);
  ok("failure went to 'all' so the orchestrator's relay_wait sees it", failMsg && failMsg.to === "all");
  ok("the exhausted account was classified (→ suggests `trantor swap`)",
     !!failMsg && /exhausted/i.test(failMsg.text) && /swap/i.test(failMsg.text));
  const erroredReg = registers.find((r) => String(r.status || "").startsWith("errored"));
  ok("presence flipped to an 'errored' status (board shows it, not green)", !!erroredReg);
  ok("the failed turn's exit code is reported", !!failMsg && /exit 1/.test(failMsg.text));
}

// ---- drill 2: a usage limit announced on STDOUT --------------------------------------
// Observed for real: the duty seat burned turns 414-418 on "You've reached your Fable 5 limit",
// every one reported as `crashed`. Only stderr was teed to the classifier's file, and the
// `claude` seat has no sid regex — so the CLI's own explanation never reached classifyFailure.
{
  const { sends } = await drill("claude",
    '#!/bin/sh\necho "You\'ve reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."\nexit 1\n');
  const failMsg = sends.find((m) => /turn FAILED/i.test(m.text || ""));
  ok("a stdout-only failure still reaches the bus", !!failMsg);
  ok("a usage limit on STDOUT is classified exhausted, not crashed",
     !!failMsg && /exhausted/i.test(failMsg.text) && !/crashed/i.test(failMsg.text));
  ok("an exhausted seat is told to swap", !!failMsg && /swap/i.test(failMsg.text));
}

// ---- drill 3: the limit wording alone, with no quota/credit vocabulary ----------------
// Guards the classifier itself: this text shares no word with the old pattern, so it proves
// the match is on "reached your … limit" and not on the incidental "credit" in /usage-credits.
{
  const { sends } = await drill("claude", '#!/bin/sh\necho "You\'ve reached your Opus 5 limit."\nexit 1\n');
  const failMsg = sends.find((m) => /turn FAILED/i.test(m.text || ""));
  ok("a bare subscription limit is classified exhausted", !!failMsg && /exhausted/i.test(failMsg.text));
}

// ---- drill: a seat that STAYS down says so once, not once per retry -------------------
// A permanently exhausted codex seat broadcast "DOWN" to `all` 31 times over six hours. Every
// broadcast is a turn for every live seat, so two working agents spent an evening re-reading the
// same sentence. The doctrine this project holds everyone else to is: report duration, not
// repetition — a state that has not changed is not news.
{
  const { sends, registers } = await drill("codex",
    '#!/bin/sh\necho "Error: you exceeded your current quota" >&2\nexit 1\n',
    // retry fast so several turns fail inside the drill's window
    // three wake-ups after the kickoff, so the seat fails four times in a row
    { inbox: [{ text: "contract: card #8001 again" }, { text: "contract: card #8002 and again" }, { text: "contract: card #8003 and again" }], waitMs: 9000 });
  const downs = sends.filter(m => /DOWN/.test(m.text || "") && m.to === "all");
  const fails = sends.filter(m => /turn FAILED/i.test(m.text || "") && m.to === "all");
  ok("the room is told the seat went down", downs.length >= 1, `${downs.length} DOWN broadcasts`);
  ok("…exactly once, however many times it retries", downs.length === 1, `${downs.length} DOWN broadcasts`);
  ok("…and the first failure is still announced separately", fails.length <= 1, `${fails.length} FAILED broadcasts`);
  const downReg = registers.filter(r => String(r.status || "").startsWith("down"));
  ok("the seat stays REGISTERED as down, which is where duration lives and costs nobody a turn",
     downReg.length >= 1, `${downReg.length} down registrations`);
}

// ---- drill 5: an auth failure that still EXITS 0 (opencode) -------------------------------
// opencode prints "401 Unauthorized" / "Invalid API key" and exits 0, so a bare 0 was read as
// success: the runner acked "✅ done", cleared the pending queue and stayed green through an auth
// outage (card #5405). The turn output must be cross-checked before a 0 means anything.
{
  const r = await drill("opencode",
    '#!/bin/sh\necho "Error: 401 Unauthorized — Invalid API key provided" >&2\nexit 0\n');
  const failMsg = r.sends.find((m) => /turn FAILED/i.test(m.text || ""));
  ok("an exit-0 auth failure is still reported to the bus", !!failMsg);
  ok("...classified as auth (→ check credentials), never as success",
     !!failMsg && /auth/i.test(failMsg.text));
  ok("the error reached err-<agent>-<proj>.txt (operator reads it live)",
     /invalid api key/i.test(r.errText), r.errText.slice(0, 120));
  ok("no success/recovery ack was posted for the failed turn",
     !r.sends.some((m) => /✅/.test(m.text || "")));
  const authReg = r.registers.find((x) => /errored: auth|down: auth/.test(String(x.status || "")));
  ok("presence flipped to an errored/down auth status (board shows it, not green)", !!authReg);
}

// ---- drill 6: an exit-0 auth STREAK flips the seat DOWN like any other failure ------------
// #6084: deterministic under load. The old body slept a fixed 9s and hoped the runner had got
// through the streak by then — under machine load the kill sometimes landed before the second
// consecutive failure, and the DOWN count came back 0. Now the drill waits for the DOWN
// broadcast itself (deadline 30s), then for the NEXT consecutive failure's registration
// ("down: auth · 3 fails"). The third failure needs the redelivery ladder shortened
// (TRANTOR_RETRY_MS, the lever the redelivery drill uses) — at the production 30s backoff a
// failed turn holds its wake, so a 3rd failure simply never happens inside any test window.
{
  const isDownBcast = (m) => /DOWN/.test(m.text || "") && m.to === "all";
  const r = await drill("opencode",
    '#!/bin/sh\necho "Invalid API key" >&2\nexit 0\n',
    { inbox: [{ text: "contract: card #8010 again" }, { text: "contract: card #8011 and again" }], env: { TRANTOR_RETRY_MS: "1500" }, quietDeadlineMs: 0,
      until: (s) => s.some(isDownBcast),
      // #6134: the streak now ENDS at the park — auth will not fix itself on a timer, so there is
      // no third failure to wait for. Settle on the park notice instead.
      settleUntil: (s) => s.some((m) => /PARKED/.test(m.text || "")) });
  const downs = r.sends.filter(isDownBcast);
  ok("an exit-0 auth streak still flips the seat DOWN", downs.length >= 1, `${downs.length} DOWN broadcasts`);
  ok("…exactly once, however many times it retries (retries keep failing every ~1.5s after it)",
     downs.length === 1, `${downs.length} DOWN broadcasts`);
  const down = downs[0];
  ok("…the broadcast is the seat-down notice: to 'all', labelled auth, streak + exit named",
     !!down && /auth/i.test(down.text || "") && /consecutive failures/.test(down.text || "") && /exit \d/.test(down.text || ""),
     down && String(down.text).slice(0, 140));
  // Was: "the later failures stay registered state" — it waited for a THIRD consecutive failure
  // on a 1.5s ladder. Since #6134 a rejected key parks instead of retrying, so the honest
  // assertion is that the seat is down on the board and the ladder has stopped.
  ok("…the down state lives on the board, where it costs nobody a turn",
     r.registers.some((x) => /^down: auth/.test(String(x.status || ""))));
  ok("#6134: …and a rejected key PARKS rather than retrying every 1.5s",
     r.sends.some((m) => /PARKED/.test(m.text || "")) && !r.sends.some((m) => /retrying in/.test(m.text || "")));
  ok("no success ack across the streak", !r.sends.some(m => /✅/.test(m.text || "")));
}

// ---- #5684 drill A: a provider BACKEND error is not quota, and the foreman is woken ----
// The specimen (#5683): codex's remote-compact 404 was labelled "exhausted" and the operator was
// told to wait out a quota window that did not exist; and the DOWN notice was a broadcast, which
// wakes nobody — the operator found the dead seat before the orchestrator did.
{
  const { sends } = await drill("codex",
    '#!/bin/sh\necho "ERROR: Error running remote compact task: unexpected status 404 Not Found" >&2\nexit 1\n',
    { env: { RELAY_HOST_ID: "drillhost" }, quietDeadlineMs: 0,
      until: (messages) => messages.some((m) => m.to === "all" && /backend-error/.test(m.text || ""))
        && messages.some((m) => m.to === "drillhost:tt-fail-codex" && /FAILED|DOWN/.test(m.text || "")) });
  const failMsg = sends.find((m) => /turn FAILED/i.test(m.text || ""));
  ok("#5684: a provider 404 is classified backend-error, never exhausted",
     !!failMsg && /backend-error/.test(failMsg.text) && !/exhausted/.test(failMsg.text));
  ok("#5684: the advice says NOT quota — retry or swap provider", !!failMsg && /NOT quota/.test(failMsg.text));
  ok("#5684: the same event also reaches the ORCHESTRATOR direct (direct = wake)",
     sends.some((m) => m.to === "drillhost:tt-fail-codex" && /FAILED|DOWN/.test(m.text || "")));
}

// ---- #5684 drill B: the turn watchdog reports a silent long turn, and never kills it ----
{
  const { sends } = await drill("claude",
    '#!/bin/sh\nuntil [ -f "$TRANTOR_TEST_STALL_RELEASE_FILE" ]; do sleep 0.01; done\necho done\nexit 0\n',
    { env: { RELAY_HOST_ID: "drillhost", TRANTOR_TURN_WATCHDOG_MS: "10" },
      releaseOnStall: true, quietDeadlineMs: 0,
      until: (messages) => messages.some((m) => /STALLED/.test(m.text || "")),
      settleUntil: (_messages, rows) => rows.some((r) => r.status === "idle") });
  const stalls = sends.filter((m) => /STALLED/.test(m.text || ""));
  ok("#5684: a silent over-window turn earns a stall report", stalls.length >= 1);
  ok("#5684: exactly ONE report per turn (episode, never a timer storm)", stalls.length === 1);
  ok("#5684: the stall goes DIRECT to the orchestrator", stalls[0]?.to === "drillhost:tt-fail-claude");
  ok("#5684: the turn was NOT killed — it finished clean, no failure reported",
     !sends.some((m) => /turn FAILED/.test(m.text || "")));
}

// ---- #6206 drill C: a TRANSCRIPT-advancing turn with silent stdout is NEVER a stall ------
// The 09:47 false alarm: claude -p prints nothing until the turn ends, and the seat was
// reported STALLED while it was editing five files. The transcript (the CLI's session file)
// moving is liveness; stdout silence alone never counts.
{
  const { sends, home, errText } = await drill("claude",
    '#!/bin/sh\nmkdir -p "$TRANTOR_TRANSCRIPT_DIR"\ni=0\nwhile [ $i -lt 40 ]; do\n  echo "{\\"role\\":\\"assistant\\"}" >> "$TRANTOR_TRANSCRIPT_DIR/session.jsonl"\n  sleep 0.1\n  i=$((i+1))\ndone\necho done\nexit 0\n',
    { env: { RELAY_HOST_ID: "drillhost", TRANTOR_TURN_WATCHDOG_MS: "400" }, quietDeadlineMs: 0,
      waitMs: 12000 });
  ok("#6206: a turn whose transcript advances is never reported STALLED, however silent its stdout",
     !sends.some((m) => /STALLED/.test(m.text || "")));
  // Completion is proven by the turn's own captured output ("done" rode stdout to ERRF), not by
  // an ack: the ✅/idle paths have their own flaky drills and this one is about the watchdog.
  ok("#6206: the chatty turn ran to completion", /done/.test(errText));
  // The liveness signal must be the one the REAL claude emits: a growing session file under the
  // project transcript dir. If this file is missing the drill proved nothing — the watchdog
  // would have stayed quiet for the wrong reason (no signal to watch at all).
  const transcriptSeen = (() => {
    try {
      for (const d of readdirSync(join(home, ".claude", "projects"))) {
        if (statSync(join(home, ".claude", "projects", d, "session.jsonl")).size > 0) return true;
      }
    } catch {}
    return false;
  })();
  ok("#6206: the fake transcript was really written where the watchdog watches", transcriptSeen);
}

// ---- #6206 drill D: a truly silent over-window turn is reported EXACTLY ONCE, then the turn ends ----
// Drill B holds the turn open on a release file; this one ends on its own, so the report must
// land mid-turn, exactly once, and the turn still finishes healthy afterwards.
{
  const { sends } = await drill("claude",
    '#!/bin/sh\nsleep 3\necho done\nexit 0\n',
    { env: { RELAY_HOST_ID: "drillhost", TRANTOR_TURN_WATCHDOG_MS: "400" }, quietDeadlineMs: 0,
      until: (messages) => messages.some((m) => /STALLED/.test(m.text || "")) });
  const stalls = sends.filter((m) => /STALLED/.test(m.text || ""));
  ok("#6206: a turn silent on every channel is reported STALLED exactly once", stalls.length === 1);
  ok("#6206: the report names what was last observed (stderr silent, nothing newer)",
     stalls.length === 1 && /last seen:/.test(stalls[0].text || ""));
  // "During the turn" holds by construction — the watchdog only reports while the stamp file
  // exists, and the runner unlinks it the instant the turn ends.
}

// ---- #6206 drill E: a turn that ends early leaves NO live timer behind -------------------
// The orphan failure mode: a watchdog that outlives its turn and reports into the next one. A
// fast silent turn must produce no stall report ever — not at the window, not after the turn.
{
  const { sends, registers } = await drill("claude",
    '#!/bin/sh\necho done\nexit 0\n',
    { env: { RELAY_HOST_ID: "drillhost", TRANTOR_TURN_WATCHDOG_MS: "400" }, quietDeadlineMs: 0,
      settleUntil: (_messages, rows) => rows.some((r) => r.status === "idle") });
  ok("#6206: a fast turn earns no stall report at all", !sends.some((m) => /STALLED/.test(m.text || "")));
  // Meaningfulness check: the runner was alive and on the bus well past the window (the harness
  // waits 2.5s — six windows — after the turn ended), so a watchdog left alive by the turn's
  // end would have had every opportunity to fire into sends.
  ok("#6206: no late report after the turn ended either", sends.some((m) => /ready for a contract/.test(m.text || "")));
}

// ---- #5481 drill A: NULL output with exit 0 is a FAILURE (the Inception/Mercury trap) -----
// Observed live (card #5481): the inception seat took three turns, every one exit 0, produced
// ZERO file changes on an explicit build contract — the completion came back JSON null because
// reasoning ate the max_tokens budget. Silence used to read as success: the runner acked "✅
// done" while nothing was produced. An empty transcript on a clean exit is a failure shape.
{
  const { sends, registers } = await drill("opencode", '#!/bin/sh\nexit 0\n',
    { env: { RELAY_HOST_ID: "drillhost" } });
  const failMsg = sends.find((m) => /turn FAILED/i.test(m.text || ""));
  ok("#5481: an exit-0 turn with NULL output is reported FAILED, never clean", !!failMsg);
  ok("#5481: it classifies as empty-output", !!failMsg && /empty-output/.test(failMsg.text));
  ok("#5481: the message names the max_tokens suspicion", !!failMsg && /max_tokens/.test(failMsg.text));
  ok("#5481: no success/recovery ack was posted for the silent turn",
     !sends.some((m) => /✅/.test(m.text || "")));
  const emptyReg = registers.find((x) => /errored: empty-output/.test(String(x.status || "")));
  ok("#5481: presence flipped to 'errored: empty-output' (board shows it, not green)", !!emptyReg);
  ok("#5481: the foreman is woken direct, not just broadcast at",
     sends.some((m) => m.to === "drillhost:tt-fail-opencode" && /FAILED/.test(m.text || "")));
}

// ---- #5481 drill B: the inception seat's message names ITS trap ----------------------------
// The dial lives in the provider's opencode model config (limit.output), not in the runner — so
// the failure's one job is to point the operator at the right knob, by name, for this provider.
{
  const { sends } = await drill("inception", '#!/bin/sh\nexit 0\n',
    { fakeName: "opencode", env: { RELAY_HOST_ID: "drillhost" } });
  const failMsg = sends.find((m) => /turn FAILED/i.test(m.text || ""));
  ok("#5481: the inception seat is classified empty-output too (BYOM opencode fallback)",
     !!failMsg && /empty-output/.test(failMsg.text));
  ok("#5481: the message names the diffusion/reasoning budget trap verbatim",
     !!failMsg && /inception: raise max_tokens — diffusion burns budget on reasoning/.test(failMsg.text));
}

// ---- #5760 drills: the overseer's same-project FYI never costs a turn ----------------------
// The night of 08-31: the hub's hourly "🤝 OVERSEER same-project-sessions" DM woke every seat
// into a real CLI turn; three wedged for hours mid-chatter (one metered). The FYI batches as
// context now; file-conflict warnings — actionable by the seat — still wake.
{
  const counter = '#!/bin/sh\necho ran >> "$HOME/runs.txt"\necho ok\nexit 0\n';
  const fyi = { from: "hub:duty", text: "🤝 OVERSEER same-project-sessions: you and x:tt are working on overlapping ground. Coordinate directly. No human needs to relay this." };
  const runsOf = (home) => { try { return readFileSync(join(home, "runs.txt"), "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };

  const a = await drill("opencode", counter, { inbox: [fyi], waitMs: 4000, keepHome: true });
  ok("#5760: a same-project overseer FYI alone never wakes a turn (kickoff only ran)",
     runsOf(a.home) === 1);

  const b = await drill("opencode", counter,
    { inbox: [fyi, { text: "real contract: do the thing" }], waitMs: 4000, keepHome: true });
  ok("#5760: a real direct still wakes, and exactly one extra turn runs", runsOf(b.home) === 2);
  ok("#5760: the FYI rides that turn as CONTEXT, not as the wake",
     (() => { try { return readFileSync(join(b.home, ".agent-bus", "turn-opencode-tt-fail-opencode.txt"), "utf8").includes("same-project-sessions"); } catch { return false; } })());

  const c = await drill("opencode", counter,
    { inbox: [{ from: "hub:duty", text: "🤝 OVERSEER file-conflict: you and x:tt are working on overlapping ground (src/a.ts)." }], waitMs: 4000, keepHome: true });
  ok("#5760: a file-conflict warning STILL wakes — that one is actionable now", runsOf(c.home) === 2);
}

// ---- #5481 drill C: positive control — a turn WITH output still exits clean ---------------
// Guards over-triggering: every real CLI prints something (opencode its response, codex its
// transcript), so output on the streams must keep meaning success.
{
  // prime one wake so the success path runs deliverWake → the assigner gets its ✅
  const { sends } = await drill("opencode", '#!/bin/sh\necho "did the thing"\nexit 0\n',
    { inbox: [{ text: "contract: do the thing on card #8020" }], waitMs: 4000 });
  ok("#5481: a turn with output and exit 0 is still success (no failure posted)",
     !sends.some((m) => /turn FAILED/.test(m.text || "")));
  ok("#5481: ...and the completion ack still goes to the assigner",
     sends.some((m) => /✅/.test(m.text || "")));
}

// ---- #6134: the time box ends a runaway turn and salvages it -------------------------
// A turn with no ceiling is how a seat spends an afternoon on one card. At the box the runner
// ends the CLI's whole process group and runs ONE follow-up turn in the SAME session, so the
// work gets committed and the card moved instead of being thrown away with the process.
{
  // Where the escaped grandchild records its pid, so the drill can ask the OS whether the sweep
  // actually reached it. A zero-length check would prove nothing: the positive control is that
  // this pid IS alive while the turn runs (asserted below) before it is asserted dead.
  const ESCAPEEF = join(mkdtempSync(join(tmpdir(), "tt-escapee-")), "pid");
  const escapeePid = () => { try { return Number(readFileSync(ESCAPEEF, "utf8").trim()) || 0; } catch { return 0; } };
  const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  let sawEscapeeAlive = false;
  const { sends, home } = await drill("codex",
    // Hangs on the CONTRACT turn and nowhere else: the kickoff must not be cut (it would use up
    // the one follow-up before the drill starts), and the follow-up must be able to land — that
    // is the behaviour under test, a cut turn whose work still gets committed.
    //
    // The hung turn also spawns a grandchild that calls setsid, which is what codex does with its
    // own commands: the child leaves the turn's process GROUP entirely, so a group signal cannot
    // reach it. It stays a descendant, which is why the sweep walks `pgrep -P` instead. Perl
    // rather than setsid(1): macOS ships /usr/bin/perl but no setsid binary.
    `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-tt-fail-codex.txt"
if grep -q "cut at the time box" "$P"; then echo "committed and reported"; exit 0; fi
if grep -q "NEW BUS MESSAGE" "$P"; then
  echo "working..."
  /usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec("sleep", "600")' &
  echo $! > "${ESCAPEEF}"
  sleep 600
fi
echo "codex-drill: turn done"
exit 0
`,
    { inbox: [{ text: "contract: card #8030, build the thing" }],
      env: { TRANTOR_TURN_MAX_MS: "2000" },
      // Wait on EMITTED EVIDENCE, not the clock. First the positive control: hold until the
      // grandchild has actually been SEEN alive, so "it is dead now" cannot pass because it never
      // started. Then hold until the sweep has killed it.
      until: () => { const pid = escapeePid(); if (pid && alive(pid)) sawEscapeeAlive = true; return sawEscapeeAlive; },
      deadlineMs: 20000,
      settleUntil: () => !alive(escapeePid()),
      settleDeadlineMs: 25000 });
  const rows = (() => {
    try {
      return readFileSync(join(home, ".agent-bus", "logs", "codex-tt-fail-codex.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    } catch { return []; }
  })();
  const cut = rows.filter((r) => r.cut);
  ok("#6134: a turn past TRANTOR_TURN_MAX_MS is cut, and the jsonl row says cut:true", cut.length >= 1);
  ok("#6134: the cut turn did not run for anything like its full sleep (the box held)",
     cut.length >= 1 && cut[0].duration_ms < 8000);
  ok("#6134: exactly ONE follow-up turn runs after the cut, in the same session",
     rows.filter((r) => r.trigger === "time-box follow-up").length === 1,
     `${rows.filter((r) => r.trigger === "time-box follow-up").length} follow-up turn(s)`);
  ok("#6134: the follow-up is not itself cut (boxing a boxed turn would never end)",
     !rows.some((r) => r.trigger === "time-box follow-up" && r.cut));
  ok("#6134: a cut turn is not silently reported as a clean success",
     !sends.some((m) => /✅ done/.test(m.text || "") && /8030/.test(m.text || "")) || cut.length >= 1);
  // #6134-followup: the residual from the real-path drill. `sleep 400` spawned by codex's shell
  // survived process.kill(-pid), because codex setsids its commands into their own group. setsid
  // does not change the PARENT, so the sweep walks pgrep -P and reaches it.
  ok("#6134-followup: the escaped grandchild was alive during the turn (positive control)",
     sawEscapeeAlive);
  ok("#6134-followup: …and a setsid grandchild does NOT survive the cut",
     escapeePid() > 0 && !alive(escapeePid()));
}

// ---- #6134: an exhausted seat PARKS — it is not redelivered to ------------------------
// The ladder assumes the next attempt might work. Against a spent plan it never will: codex took
// 60 redelivery turns on 09-02 doing nothing but being woken to fail. Now the seat says so ONCE,
// with the reset time the CLI printed, and stops until that time or a restart.
{
  let parkedAt = 0;
  const { sends } = await drill("codex",
    '#!/bin/sh\necho "You\'ve hit your usage limit. Try again at Sep 3rd, 2099 3:34 AM" >&2\nexit 1\n',
    { inbox: [{ text: "contract: card #8040, build the thing" }],
      // #6134-followup, the #4854 lesson: this failed 1 run in 2 on a loaded machine because a
      // fixed 9s sleep measures the LOAD, not the behaviour. Anchor on emitted evidence instead —
      // hold until the park notice is actually on the bus, then hold a window measured from THAT
      // moment which provably spans five missed retry slots at the 800ms ladder. The negative
      // assertion below is then about a window the runner really had the chance to fill.
      env: { TRANTOR_RETRY_MS: "800" }, quietDeadlineMs: 0,
      until: (sent) => { if (!parkedAt && sent.some((m) => /PARKED/.test(m.text || ""))) parkedAt = Date.now(); return !!parkedAt; },
      deadlineMs: 30000,
      settleUntil: () => parkedAt > 0 && Date.now() - parkedAt > 4000,
      settleDeadlineMs: 30000 });
  const parks = sends.filter((m) => /PARKED/.test(m.text || "") && m.to === "all");
  ok("#6134: an exhausted seat announces that it is PARKED", parks.length >= 1);
  ok("#6134: …exactly once, not once per retry", parks.length === 1, `${parks.length} park broadcasts`);
  ok("#6134: the park names the reset time the CLI printed",
     parks.length >= 1 && /2099/.test(parks[0].text));
  ok("#6134: the assigner is told directly that the contract is parked, not retrying",
     sends.some((m) => /PARKED/.test(m.text || "") && m.to === "host:drill"));
  // The whole point: with an 800ms ladder a 9s window would otherwise show many attempts.
  ok("#6134: the redelivery ladder STOPS — no retry notices after the park",
     !sends.some((m) => /retrying in/.test(m.text || "")),
     sends.filter((m) => /retrying in/.test(m.text || "")).length + " retry notice(s)");
}

// ---- #6289 drill A: a cut turn's follow-up RESUMES the same CLI session, never a fresh -p ----
// The second half of the 4.7h burn: a time-box cut re-ran as a FULL fresh turn, so the seat
// re-read everything and re-did the work. The follow-up must ride the CLI's resume shape — for
// claude that is argv `-c` (continue the session it was cut out of). Also pins #6289's ledger
// rule: every row carries outcome (cut | api-error | completed) and tokens.
{
  const { sends, home } = await drill("claude",
    `#!/bin/sh
echo "$@" >> "$HOME/claude-argv.log"
P="$HOME/.agent-bus/turn-claude-tt-fail-claude.txt"
if grep -q "NEW BUS MESSAGE" "$P"; then
  if grep -q "cut at the time box" "$P"; then echo "landed the cut work"; exit 0; fi
  echo "tokens used: 4,321"
  sleep 30
fi
echo "claude-drill: turn done"
exit 0
`,
    { inbox: [{ from: "host:tt-fail-claude", text: "contract: card #8050, build the thing" }],
      env: { TRANTOR_TURN_MAX_MS: "1500", CREW_MODEL: "" },
      until: (s) => s.some((m) => /✅ done/.test(m.text || "")),
      deadlineMs: 25000 });
  const argvs = (() => { try { return readFileSync(join(home, "claude-argv.log"), "utf8").trim().split("\n"); } catch { return []; } })();
  const resumes = argvs.filter((a) => a.startsWith("-c "));
  ok("#6289: a cut turn is followed by exactly ONE resume turn (kickoff + contract + resume = 3 CLI calls)",
    argvs.length === 3 && resumes.length === 1, `argv lines: ${argvs.length}, resumes: ${resumes.length}`);
  ok("#6289: the time-box follow-up carries the CLI's RESUME shape (-c), never a fresh -p",
    resumes.length === 1 && resumes[0].includes("cut at the time box"),
    resumes[0] && resumes[0].slice(0, 120));
  const rows = (() => {
    try {
      return readFileSync(join(home, ".agent-bus", "logs", "claude-tt-fail-claude.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    } catch { return []; }
  })();
  const turnRows = rows.filter((r) => r.trigger);
  ok("#6289: the cut turn's ledger row carries outcome:'cut'",
    turnRows.some((r) => r.cut === true && r.outcome === "cut"));
  ok("#6289: the follow-up's ledger row carries outcome:'completed'",
    turnRows.some((r) => r.trigger === "time-box follow-up" && r.outcome === "completed"));
  ok("#6289: EVERY ledger row names its outcome (cut | api-error | completed) and its tokens",
    turnRows.length > 0 && turnRows.every((r) => ["cut", "api-error", "completed"].includes(r.outcome) && Number.isFinite(r.tokens)),
    JSON.stringify(turnRows.map((r) => ({ t: r.trigger, o: r.outcome, k: r.tokens }))));
}

// ---- #6289 drill B: a twice-cut contract PARKS the seat as time-box — no third attempt -------
// Rule 1's time-box flavor: the contract attempt is cut, its follow-up is cut too (the chain
// fails), the ladder retries ONCE, and the second failed chain parks with reason time-box and
// one line on the board — never a third attempt, never N retry notices.
{
  let parkedAt = 0;
  const { sends, home } = await drill("claude",
    `#!/bin/sh
{ echo "===TURN==="; cat "$HOME/.agent-bus/turn-claude-tt-fail-claude.txt"; } >> "$HOME/turns.log"
sleep 30
`,
    { inbox: [{ from: "host:tt-fail-claude", text: "contract: card #8060, build the thing" }],
      env: { TRANTOR_TURN_MAX_MS: "1200", TRANTOR_RETRY_MS: "800", CREW_MODEL: "" }, quietDeadlineMs: 0,
      until: (s) => { if (!parkedAt && s.some((m) => /PARKED/.test(m.text || ""))) parkedAt = Date.now(); return !!parkedAt; },
      deadlineMs: 30000,
      settleUntil: () => parkedAt > 0 && Date.now() - parkedAt > 4500,
      settleDeadlineMs: 30000 });
  const turns = (() => { try { return readFileSync(join(home, "turns.log"), "utf8").split("===TURN===").filter(t => t.trim()); } catch { return []; } })();
  const attempts = turns.filter((t) => t.includes("NEW BUS MESSAGE"));
  ok("#6289: a twice-cut contract is attempted exactly TWICE — the park replaces the third attempt",
    attempts.length === 2, `got ${attempts.length} contract attempt(s)`);
  const parks = sends.filter((m) => /PARKED/.test(m.text || "") && m.to === "all");
  ok("#6289: the park is ONE line on the board, not a notice per retry",
    parks.length === 1, `${parks.length} park broadcast(s)`);
  ok("#6289: the park names the reason (time-box)",
    parks.length === 1 && /time-box/.test(parks[0].text || ""), parks[0] && String(parks[0].text).slice(0, 140));
  ok("#6289: the assigner is told the contract is parked, once, directly",
    sends.filter((m) => /PARKED/.test(m.text || "") && m.to === "host:tt-fail-claude").length === 1);
  ok("#6289: the queue survives the park (a restart resumes it)",
    existsSync(join(home, ".agent-bus", "pending-claude-tt-fail-claude.json")));
  const rows = (() => {
    try {
      return readFileSync(join(home, ".agent-bus", "logs", "claude-tt-fail-claude.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    } catch { return []; }
  })();
  const cutRows = rows.filter((r) => r.outcome === "cut");
  // The kickoff chain is cut too (every invocation hangs): 3 chains × 2 turns = 6 cut rows.
  ok("#6289: every cut turn in every chain is ledgered as outcome:'cut' (3 chains × 2 turns)",
    cutRows.length === 6, `${cutRows.length} cut row(s)`);
  ok("#6289: each chain ran its ONE follow-up in the same session",
    rows.filter((r) => r.trigger === "time-box follow-up").length === 3);
}

hub.close();

console.log(`\nfailure drills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
