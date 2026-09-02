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
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("# trantor crew failure-visibility drill");

// ---- mock hub: record /register + /send, answer the runner's polls -------------------
const registers = [], sends = [];
let inboxQueue = [];
const hub = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/register") { try { registers.push(JSON.parse(buf)); } catch {} return reply({ ok: true, session: "x", peers: [] }); }
    if (req.method === "POST" && P === "/send") { try { sends.push(JSON.parse(buf)); } catch {} return reply({ ok: true, id: sends.length }); }
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
  // an inbox item is a plain string (sender host:drill) or {from, text} — #5760's legs need to
  // speak as hub:duty to drill the overseer-FYI wake policy.
  inboxQueue = (opts.inbox || []).map((m, i) => {
    const o = typeof m === "string" ? { text: m } : m;
    return { id: i + 1, from: o.from || "host:drill", to: `${agent}:tt-fail-${agent}`, text: o.text, project: `tt-fail-${agent}` };
  });
  const work = mkdtempSync(join(tmpdir(), `tt-fail-${agent}-`));
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
    env: { ...process.env, HOME, PATH: `${fakebin}:${process.env.PATH}`,
           RELAY_URL: HUB, RELAY_AGENT: agent, RELAY_PROJECT: `tt-fail-${agent}`,
           CREW_KICKOFF: "say hi and end your turn", ...(opts.env || {}) },
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
  runner.kill("SIGKILL");
  await sleep(150);
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
    { inbox: ["again", "and again", "and again"], waitMs: 9000 });
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
    { inbox: ["again", "and again"], env: { TRANTOR_RETRY_MS: "1500" },
      until: (s) => s.some(isDownBcast),
      settleUntil: (s, regs) => regs.some((x) => /down: auth · 3 fails/.test(String(x.status || ""))) });
  const downs = r.sends.filter(isDownBcast);
  ok("an exit-0 auth streak still flips the seat DOWN", downs.length >= 1, `${downs.length} DOWN broadcasts`);
  ok("…exactly once, however many times it retries (retries keep failing every ~1.5s after it)",
     downs.length === 1, `${downs.length} DOWN broadcasts`);
  const down = downs[0];
  ok("…the broadcast is the seat-down notice: to 'all', labelled auth, streak + exit named",
     !!down && /auth/i.test(down.text || "") && /consecutive failures/.test(down.text || "") && /exit \d/.test(down.text || ""),
     down && String(down.text).slice(0, 140));
  ok("…and the later failures stay registered state, never re-broadcast",
     r.registers.some((x) => /down: auth · 3 fails/.test(String(x.status || ""))));
  ok("no success ack across the streak", !r.sends.some(m => /✅/.test(m.text || "")));
}

// ---- #5684 drill A: a provider BACKEND error is not quota, and the foreman is woken ----
// The specimen (#5683): codex's remote-compact 404 was labelled "exhausted" and the operator was
// told to wait out a quota window that did not exist; and the DOWN notice was a broadcast, which
// wakes nobody — the operator found the dead seat before the orchestrator did.
{
  const { sends } = await drill("codex",
    '#!/bin/sh\necho "ERROR: Error running remote compact task: unexpected status 404 Not Found" >&2\nexit 1\n',
    { env: { RELAY_HOST_ID: "drillhost" } });
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
    '#!/bin/sh\nsleep 6\necho done\nexit 0\n',
    { env: { RELAY_HOST_ID: "drillhost", TRANTOR_TURN_WATCHDOG_MS: "1500" }, waitMs: 8000 });
  const stalls = sends.filter((m) => /STALLED/.test(m.text || ""));
  ok("#5684: a silent over-window turn earns a stall report", stalls.length >= 1);
  ok("#5684: exactly ONE report per turn (episode, never a timer storm)", stalls.length === 1);
  ok("#5684: the stall goes DIRECT to the orchestrator", stalls[0]?.to === "drillhost:tt-fail-claude");
  ok("#5684: the turn was NOT killed — it finished clean, no failure reported",
     !sends.some((m) => /turn FAILED/.test(m.text || "")));
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
    { inbox: ["do the thing"], waitMs: 4000 });
  ok("#5481: a turn with output and exit 0 is still success (no failure posted)",
     !sends.some((m) => /turn FAILED/.test(m.text || "")));
  ok("#5481: ...and the completion ack still goes to the assigner",
     sends.some((m) => /✅/.test(m.text || "")));
}

hub.close();

console.log(`\nfailure drills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
