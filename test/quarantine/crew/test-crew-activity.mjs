#!/usr/bin/env node
// trantor crew ACTIVITY drill (#5965): the runner is the source of truth for a seat's activity,
// registering `working · <trigger>` when a turn starts and `idle` when it lands clean, which is
// what the app's seat rows fall back to when herdr skips screen detection. Hermetic (#7771): a
// mock recording hub + a fake CLI driving the real runner, deadline-polled not wall-clock-sliced.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../../drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` — ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("# trantor crew activity drill");

// ---- mock hub: record every /register status, answer polls -----------------------------
const registers = [];
let inboxQueue = [];
const hub = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/register") { try { registers.push(JSON.parse(buf)); } catch {} return reply({ ok: true, session: "x", peers: [] }); }
    if (req.method === "POST" && P === "/send") return reply({ ok: true, id: 1 });
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    // #7763: a wake's card binding needs the board to CONFIRM the cited id — an unconfirmed
    // citation binds nothing, so the mock board confirms every id the drill cites.
    if (P === "/card") return reply({ task: { id: Number(u.searchParams.get("id")), title: "drill card", status: "doing", assignee: "" } });
    if (P === "/poll") {
      const m = inboxQueue.splice(0, 1);
      return reply({ messages: m, cursor: (Number(u.searchParams.get("since")) || 0) + m.length });
    }
    if (P === "/lessons") return reply({ lessons: [] });
    return reply({ ok: true });
  });
});
await new Promise((r) => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

const statuses = () => registers.map((r) => String(r.status || ""));

async function drill(agent, script, opts = {}) {
  registers.length = 0;
  // SAFETY: an inbox entry is either the message text itself or an object carrying .text —
  // `m.text ?? m` decodes both shapes at this boundary; anything else is a drill bug and throws.
  // The host speaks from the seat's OWN project (#6228): a cross-project sender is dropped
  // without acting, so "host:drill" starved every queued message and this turn never ran.
  const PROJ = `tt-act-${agent}`;
  inboxQueue = (opts.inbox || []).map((m, i) => ({
    id: i + 1, from: `host:${PROJ}`, to: `${agent}:${PROJ}`, text: m.text ?? m, project: PROJ,
  }));
  const work = mkdtempSync(join(tmpdir(), `tt-act-${agent}-`));
  const fakebin = join(work, "bin");
  mkdirSync(fakebin, { recursive: true });
  const fake = join(fakebin, agent);
  writeFileSync(fake, script);
  chmodSync(fake, 0o755);

  const HOME = join(work, "home");
  mkdirSync(join(HOME, ".agent-bus"), { recursive: true });
  const runner = spawn("node", ["bin/crew-runner.mjs", agent, work], {
    cwd: process.cwd(),
    env: { ...drillEnv(), HOME, PATH: `${fakebin}:${process.env.PATH}`,
           RELAY_URL: HUB, RELAY_AGENT: agent, RELAY_PROJECT: PROJ,
           CREW_KICKOFF: "say hi and end your turn" },
    stdio: "ignore",
  });
  // DEADLINE, not a fixed sleep (#7771): poll until the expected end-state is RECORDED, then
  // assert. A loaded machine gets the same window as an idle one and a healthy run ends the
  // moment the last transition lands, instead of guessing a wall-clock slice that races the
  // real scheduler.
  const deadline = Date.now() + (opts.deadlineMs ?? 30000);
  while (Date.now() < deadline && !opts.waitUntil(statuses())) await sleep(100);
  runner.kill("SIGKILL");
  await sleep(150);
  return statuses();
}
// Plain output long enough to clear SUBSTANTIVE_MIN (120 chars of signal, #7759): a shorter
// exit-0 turn reads as EMPTY, the wake stays owed and the ladder backs off — the direct-message
// turn the drill watches would only ever half-run. (The failing drill exits 1, EMPTY never applies.)
const WORKED = "worked the turn: read the cited card, edited the file under the seat worktree, reran the checks, recorded the outcome on the bus.";

// ---- drill 1: a clean turn registers working·trigger at start, idle at end --------------
{
  const st = await drill("codex", `#!/bin/sh\necho "${WORKED}"\nexit 0\n`,
    { waitUntil: (s) => s.includes("idle") });
  ok("turn start registered as 'working · kickoff'", st.some((s) => s === "working · kickoff"), st.join(" | "));
  ok("turn end registered 'idle'", st.some((s) => s === "idle"), st.join(" | "));
  const workingIdx = st.indexOf("working · kickoff");
  const idleIdx = st.lastIndexOf("idle");
  ok("working came BEFORE idle (the pulse is live during the turn, not after)",
     workingIdx >= 0 && idleIdx > workingIdx, st.join(" | "));
  ok("a clean turn never registers down/errored",
     !st.some((s) => s.startsWith("down") || s.startsWith("errored")), st.join(" | "));
}

// ---- drill 2: a message-driven turn carries ITS trigger, then returns to idle -----------
{
  const st = await drill("codex", `#!/bin/sh\necho "${WORKED}"\nexit 0\n`,
    { inbox: ["contract: do the thing on card #4412"],   // cites a card: since #6134 prose alone batches
      waitUntil: (s) => { const w = s.indexOf("working · direct message"); return w >= 0 && s.lastIndexOf("idle") > w; } });
  ok("a direct-message turn registers 'working · direct message'",
     st.some((s) => s === "working · direct message"), st.join(" | "));
  ok("the seat returns to 'idle' after the wake turn",
     st.lastIndexOf("idle") > st.indexOf("working · direct message"), st.join(" | "));
}

// ---- drill 3: a FAILED turn registers working at start, then errored — never idle ------
{
  const st = await drill("codex", '#!/bin/sh\necho "boom: unexpected crash" >&2\nexit 1\n',
    { waitUntil: (s) => s.some((x) => x.startsWith("errored") || x.startsWith("down")) });
  ok("a failing turn still opened as 'working · kickoff'", st.some((s) => s === "working · kickoff"), st.join(" | "));
  ok("the failure flipped the seat to an errored status (down styling, not idle)",
     st.some((s) => s.startsWith("errored") || s.startsWith("down")), st.join(" | "));
  const workingIdx = st.indexOf("working · kickoff");
  const errIdx = st.findIndex((s) => s.startsWith("errored") || s.startsWith("down"));
  ok("working came before the errored flip", workingIdx >= 0 && errIdx > workingIdx, st.join(" | "));
  ok("a failed turn never reports a clean idle", !st.includes("idle"), st.join(" | "));
}

hub.close();

console.log(`\nactivity drills: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
