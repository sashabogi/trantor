#!/usr/bin/env node
// #7752 silent-stall drill — a CLI that goes silent is a different cut from one that is busy.
// SILENT: no bytes on either stream and no transcript advance for the whole watchdog window,
// so the runner ends the turn AT THE WINDOW with outcome "stalled" — never exhausted/crashed,
// never the full box. BUSY: output keeps advancing, so the turn runs to the box and is cut
// with outcome "cut", exactly as before. Runs the REAL runner + REAL watchdog with a fake CLI;
// the mock hub is hermetic (ephemeral port, mkdtemp homes, no live bus state).
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { drillEnv } from "../drill-env.mjs";
import { cutSignalFor, stallVerdict, classifyFailure } from "../../lib/classify-failure.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

console.log("# trantor silent-stall drill (#7752)");

// ---- unit: the cut signal and the stall verdict -----------------------------------------------
console.log("\n## the rules");
{
  ok("exit 141 on a cut IS the SIGPIPE cut signal", cutSignalFor(141) === "SIGPIPE");
  ok("any other exit is not a cut signal", cutSignalFor(137) === "" && cutSignalFor(0) === "");
  ok("141 is never matched as a quota pattern, whatever the captured text says",
    classifyFailure(141, "Error: rate-limit: you exceeded your quota, try again later").reason === "cut-signal");
  ok("141 is never matched as a crash pattern either",
    classifyFailure(141, "").reason === "cut-signal" && !/crash/.test(classifyFailure(141, "").reason));
  ok("the stall verdict names the silence, not a provider failure",
    stallVerdict() === "classified stalled because no bytes on either stream and no transcript advance for the whole watchdog window");
}

// ---- mock hub: hand out ONE direct contract, then stay silent forever --------------------------
const sends = [];
let eventSeq = 0;
let handed = 0;
const MSG = { id: 7, from: "sasha@mac", to: "", text: "contract: work card #7001 now", ts: Date.now() };
const hub = http.createServer((req, res) => {
  let buf = ""; req.on("data", c => (buf += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), P = u.pathname;
    const reply = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && P === "/send") {
      try { sends.push(JSON.parse(buf)); eventSeq++; } catch {}
      return reply({ ok: true, id: sends.length });
    }
    if (P === "/events") return reply({ events: [], cursor: eventSeq, latest: eventSeq });
    if (P === "/inbox") return reply({ messages: [], cursor: 0 });
    if (P === "/contracts") return reply({ contracts: [] });
    if (P === "/lessons") return reply({ lessons: [] });
    if (P === "/policy") return reply({ links: [], autonomy: { "*": 1 } });
    if (P === "/poll") {
      if (handed === 0) { handed = 1; return reply({ messages: [{ ...MSG, to: u.searchParams.get("session") }], cursor: 1 }); }
      return setTimeout(() => reply({ messages: [], cursor: 1 }), 250);
    }
    return reply({ ok: true });
  });
});
await new Promise(r => hub.listen(0, "127.0.0.1", r));
const HUB = `http://127.0.0.1:${hub.address().port}`;

// ---- harness: the REAL runner + REAL watchdog + a fake `codex` --------------------------------
// silent: a banner, then nothing — no stream moves, no transcript, no worktree. busy: a line
// past the 200-byte liveness bar every 300ms, forever. The box is 6s and the watchdog window
// 2.5s, so a silent turn must end well before the box and a busy one never before it.
async function drill(mode, { waitMs = 30000, untilPark = true } = {}) {
  sends.length = 0; eventSeq = 0; handed = 0;
  const root = mkdtempSync(join(tmpdir(), "tt-stall-"));
  const HOME = join(root, "home");
  const REPO = join(root, "repo");
  const BUS = join(HOME, ".agent-bus");
  mkdirSync(BUS, { recursive: true });
  mkdirSync(REPO, { recursive: true });
  execSync("git init -q", { cwd: REPO });
  const fakebin = join(root, "bin"); mkdirSync(fakebin, { recursive: true });
  const LOGF = join(root, "turns.log"), CNTF = join(root, "count");
  const PROJ = "tt-stall";
  const body = mode === "silent"
    ? `echo "OpenAI Codex v2.3.4"
echo "workdir: $PWD"
echo "model: qwen3-specimen"
/bin/sleep 30
`
    : `echo "OpenAI Codex v2.3.4"
if ! grep -q "NEW BUS MESSAGE" "$P"; then exit 0; fi
while :; do echo "working: the drill keeps producing output well past the two-hundred-byte liveness bar the watchdog watches"; sleep 0.3; done
`;
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
{ echo "===TURN==="; cat "$P"; } >> "${LOGF}"
${body}
`, { mode: 0o755 });
  chmodSync(join(fakebin, "codex"), 0o755);
  const PENDF = join(BUS, `pending-codex-${PROJ}.json`);
  const JSONL = join(BUS, "logs", `codex-${PROJ}.jsonl`);
  const runner = spawn("node", ["bin/crew-runner.mjs", "codex", REPO], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...drillEnv({ TRANTOR_NO_DESKTOP_NOTIFY: "1", RELAY_HOST_ID: "drillhost" }), HOME, PATH: `${fakebin}:${process.env.PATH}`,
      RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
      TRANTOR_TURN_MAX_MS: "6000", TRANTOR_TURN_WATCHDOG_MS: "2500", TRANTOR_RETRY_MS: "1200",
      CREW_MODEL: "qwen3/deepseek-v4-pro", CREW_KICKOFF: "say hi and end your turn" },
  });
  const start = Date.now();
  if (untilPark) {
    while (!sends.some(s => /PARKED/.test(s.text || "")) && Date.now() - start < waitMs) await sleep(200);
  } else {
    await sleep(waitMs);
  }
  runner.kill("SIGKILL"); await sleep(150);
  const turns = read(LOGF).split("===TURN===").filter(t => t.trim());
  const rows = read(JSONL).split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
  return { wakeTurns: turns.filter(t => t.includes("NEW BUS MESSAGE")), rows, handed,
    sends: [...sends], pendingLeft: existsSync(PENDF), PENDF };
}

// ---- drill 1: a CLI that goes SILENT is cut at the window, never at the box --------------------
console.log("\n## a silent turn ends at the stall window");
{
  const r = await drill("silent");
  const wakeRow = r.rows.find(x => x.trigger === "direct message" && x.stalled === true);
  ok("#7752: the silent contract turn is ledgered outcome 'stalled' with the stalled flag",
    wakeRow && wakeRow.outcome === "stalled" && wakeRow.cut === true,
    JSON.stringify(wakeRow && { outcome: wakeRow.outcome, cut: wakeRow.cut, exit: wakeRow.exit }));
  ok("#7752: it ended at the 2.5s window, nowhere near the 6s box",
    wakeRow && wakeRow.duration_ms < 5500, `duration ${wakeRow && wakeRow.duration_ms}ms`);
  ok("#7752: the row names the model the seat was pinned to",
    wakeRow && wakeRow.model === "qwen3/deepseek-v4-pro", wakeRow && wakeRow.model);
  ok("#7752: the verdict names the silence, never a provider failure",
    wakeRow && /no bytes on either stream/.test(wakeRow.verdict || ""), wakeRow && wakeRow.verdict);
  ok("#7752: the stall report went to the orchestrator direct",
    r.sends.some(s => s.to === "drillhost:tt-stall" && /turn STALLED/.test(s.text || "")));
  ok("#7752: no exhausted or crashed reading anywhere on the bus",
    !r.sends.some(s => /exhausted|crashed/i.test(s.text || "")),
    r.sends.filter(s => /exhausted|crashed/i.test(s.text || "")).map(s => s.text?.slice(0, 80)).join(" | "));
  ok("#7752: the hub handed the contract out ONCE — redeliveries come from the runner's own queue",
    r.handed === 1, `handed ${r.handed}`);
  ok("#7752: the seat PARKED after two silent chains instead of a third attempt",
    r.sends.some(s => s.to === "all" && /PARKED/.test(s.text || "")));
  const park = r.sends.find(s => s.to === "all" && /PARKED/.test(s.text || ""));
  ok("#7752: the park reads stalled — never exhausted or crashed — and names the CLI and model",
    park && /\(stalled/.test(park.text || "") && !/exhausted|crashed/i.test(park.text || "")
    && /codex/.test(park.text || "") && /qwen3\/deepseek-v4-pro/.test(park.text || ""),
    park && String(park.text).slice(0, 140));
  ok("#7752: the assigner hears STALLED with the wake still owed, never a clean done",
    r.sends.some(s => s.to === "sasha@mac" && /STALLED on/.test(s.text || "") && /wake stays owed/.test(s.text || ""))
    && !r.sends.some(s => /✅ done on/.test(s.text || "")));
  ok("#7752: the vanished contract's wake is NOT consumed — the queue survives the park",
    r.pendingLeft);
}

// ---- drill 2: a BUSY turn runs to the box and is cut, exactly as before ------------------------
console.log("\n## a busy turn is still a box cut");
{
  const r = await drill("busy", { waitMs: 12000, untilPark: false });
  const cutRow = r.rows.find(x => x.trigger === "direct message" && x.cut === true);
  ok("#7752: the busy contract turn is cut at the box, outcome 'cut', never 'stalled'",
    cutRow && cutRow.outcome === "cut" && !cutRow.stalled,
    JSON.stringify(cutRow && { outcome: cutRow.outcome, stalled: cutRow.stalled, duration: cutRow.duration_ms }));
  ok("#7752: it ran to the 6s box, so the stall window never claimed a producing turn",
    cutRow && cutRow.duration_ms >= 5500, `duration ${cutRow && cutRow.duration_ms}ms`);
  ok("#7752: no stalled row exists anywhere in the busy run",
    !r.rows.some(x => x.outcome === "stalled" || x.stalled === true));
  ok("#7752: no STALLED report and no exhausted reading for a busy turn",
    !r.sends.some(s => /turn STALLED|exhausted|crashed/i.test(s.text || "")));
  ok("#7752: the cut turn ran its ONE follow-up in the same session",
    r.rows.filter(x => x.trigger === "time-box follow-up").length === 1,
    `${r.rows.filter(x => x.trigger === "time-box follow-up").length} follow-up(s)`);
}

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
