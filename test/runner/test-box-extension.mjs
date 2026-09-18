#!/usr/bin/env node
// #7761 liveness-box drill — real runner + real watchdog + a fake `codex` that writes files.
// WRITER: writes past the box, then exits 0 → extended, completed. QUIET: writes, then silent →
// one extension, then stalled AT THE WINDOW. FOREVER: never stops → cut at the ceiling, extensions == max.
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drillEnv } from "../drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

// The clock the drills reason with. Box 8s, step = box/2 = 4s, ceiling 20s → 3 extensions max.
// Window 2s (poll 500ms, lead = poll + SLACK = 2.5s): extension checks fire at ~5.5s, ~9.5s, ~13.5s.
const BOX_MS = 8000, STEP_MS = 4000, CEILING_MS = 20000, WINDOW_MS = 2000;
const EXT_MAX = Math.floor((CEILING_MS - BOX_MS) / STEP_MS);

console.log("# trantor liveness-box drill (#7761)");

// ---- mock hub: hand out ONE direct contract, record every send --------------------------------
const sends = [];
let eventSeq = 0;
let handed = 0;
const MSG = { id: 7, from: "sasha@mac", to: "", text: "contract: build card #7001 now", ts: Date.now() };
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

// The fake CLI writes into $PWD (the seat's worktree, the watchdog's worktree channel) and says
// nothing on stdout while it works — the extension must come from the files, not from bytes.
// `writeFor` seconds of writing, then `after` (a shell fragment) decides how the turn ends.
async function drill(name, { writeFor, after, waitMs }) {
  sends.length = 0; eventSeq = 0; handed = 0;
  const root = mkdtempSync(join(tmpdir(), "tt-ext-"));
  const HOME = join(root, "home");
  const REPO = join(root, "repo");
  const BUS = join(HOME, ".agent-bus");
  mkdirSync(BUS, { recursive: true });
  mkdirSync(REPO, { recursive: true });
  execSync("git init -q", { cwd: REPO });
  const fakebin = join(root, "bin"); mkdirSync(fakebin, { recursive: true });
  const PROJ = `tt-ext-${name}`;
  writeFileSync(join(fakebin, "codex"), `#!/bin/sh
P="$HOME/.agent-bus/turn-codex-${PROJ}.txt"
echo "OpenAI Codex v2.3.4"
if ! grep -q "NEW BUS MESSAGE" "$P"; then exit 0; fi
i=0
end=$(( $(date +%s) + ${writeFor} ))
while [ "$(date +%s)" -lt "$end" ]; do
  i=$((i+1)); echo "build step $i" > "$PWD/build-$i.txt"; sleep 0.3
done
${after}
`, { mode: 0o755 });
  const JSONL = join(BUS, "logs", `codex-${PROJ}.jsonl`);
  const runner = spawn("node", ["bin/crew-runner.mjs", "codex", REPO], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...drillEnv({ TRANTOR_NO_DESKTOP_NOTIFY: "1", RELAY_HOST_ID: "drillhost" }), HOME, PATH: `${fakebin}:${process.env.PATH}`,
      RELAY_URL: HUB, RELAY_AGENT: "codex", RELAY_PROJECT: PROJ,
      TRANTOR_TURN_MAX_MS: String(BOX_MS), TRANTOR_TURN_CEILING_MS: String(CEILING_MS),
      TRANTOR_TURN_WATCHDOG_MS: String(WINDOW_MS), TRANTOR_RETRY_MS: "1200",
      CREW_MODEL: "qwen3/deepseek-v4-pro", CREW_KICKOFF: "say hi and end your turn" },
  });
  const start = Date.now();
  // Wait for the contract turn's own ledger row (the first direct-message row), bounded.
  const rowsNow = () => read(JSONL).split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
  while (!rowsNow().some(x => x.trigger === "direct message") && Date.now() - start < waitMs) await sleep(200);
  await sleep(600);   // let the post-turn notices land on the mock hub
  runner.kill("SIGKILL"); await sleep(150);
  const rows = rowsNow();
  const row = rows.find(x => x.trigger === "direct message");
  const extended = sends.filter(s => /turn extended/.test(s.text || ""));
  return { rows, row, sends: [...sends], extended };
}

// ---- drill 1: a CLI that keeps writing files past the box is extended and completes -----------
console.log("\n## a turn that keeps moving is extended and completes");
{
  const r = await drill("writer", { writeFor: 10, after: 'echo "build green: 22 tests passed, committed"; exit 0', waitMs: 30000 });
  ok("#7761: the contract turn COMPLETED, outcome completed, never cut",
    r.row && r.row.outcome === "completed" && !r.row.cut,
    JSON.stringify(r.row && { outcome: r.row.outcome, cut: r.row.cut, duration: r.row.duration_ms }));
  ok("#7761: it ran PAST the 8s box, which the extension made possible",
    r.row && r.row.duration_ms > BOX_MS, `duration ${r.row && r.row.duration_ms}ms`);
  ok("#7761: the ledger row records the extensions and the box the turn actually had",
    r.row && r.row.extensions >= 1 && r.row.boxMs === BOX_MS + r.row.extensions * STEP_MS,
    JSON.stringify(r.row && { extensions: r.row.extensions, boxMs: r.row.boxMs }));
  ok("#7761: the assigner heard each extension, as context (wake:false), never as a turn",
    r.extended.some(s => s.to === "sasha@mac" && s.wake === false && s.kind === "status")
    && r.extended.filter(s => s.to === "sasha@mac").length === r.row?.extensions,
    `${r.extended.filter(s => s.to === "sasha@mac").length} notice(s) vs ${r.row?.extensions} extension(s)`);
  ok("#7761: the notice names what was alive and the box against the ceiling",
    r.extended.some(s => /alive: worktree/.test(s.text || "") && /of a 20s ceiling/.test(s.text || "")),
    r.extended[0] && r.extended[0].text);
  ok("#7761: the foreman heard it too",
    r.extended.some(s => s.to === "drillhost:tt-ext-writer"));
  ok("#7761: no notice ever carries `re` — an extension is not the contract's answer",
    r.extended.every(s => s.re === undefined));
  ok("#7761: the assigner heard done, never a cut or a stall",
    r.sends.some(s => s.to === "sasha@mac" && /✅ done on/.test(s.text || ""))
    && !r.sends.some(s => /STALLED|PARKED/.test(s.text || "")));
}

// ---- drill 2: a turn that goes silent is stalled at the window, extended or not ----------------
console.log("\n## a turn that goes silent still ends at the stall window");
{
  const r = await drill("quiet", { writeFor: 5, after: "/bin/sleep 30", waitMs: 30000 });
  ok("#7761: the turn is ledgered STALLED (#7752), never completed and never a plain cut",
    r.row && r.row.outcome === "stalled" && r.row.stalled === true,
    JSON.stringify(r.row && { outcome: r.row.outcome, stalled: r.row.stalled, duration: r.row.duration_ms }));
  ok("#7761: it was extended once while it moved (deadline 12s), then the window ended it near 9-10.5s, before that deadline",
    r.row && r.row.extensions === 1 && r.row.duration_ms < BOX_MS + STEP_MS,
    JSON.stringify(r.row && { extensions: r.row.extensions, duration: r.row.duration_ms }));
  ok("#7761: exactly one extension notice reached the assigner",
    r.extended.filter(s => s.to === "sasha@mac").length === 1);
  ok("#7761: the stall report still went to the foreman",
    r.sends.some(s => s.to === "drillhost:tt-ext-quiet" && /turn STALLED/.test(s.text || "")));
}

// ---- drill 3: a turn that never stops is cut at the ceiling, extensions == max ------------------
console.log("\n## the ceiling is respected");
{
  const r = await drill("forever", { writeFor: 120, after: "exit 0", waitMs: 45000 });
  ok("#7761: the turn is CUT (outcome cut, never stalled) — it was alive the whole way",
    r.row && r.row.outcome === "cut" && r.row.cut === true && !r.row.stalled,
    JSON.stringify(r.row && { outcome: r.row.outcome, stalled: r.row.stalled }));
  ok(`#7761: extensions stopped at the ceiling: ${EXT_MAX} of ${EXT_MAX}, boxMs == ceiling`,
    r.row && r.row.extensions === EXT_MAX && r.row.boxMs === CEILING_MS,
    JSON.stringify(r.row && { extensions: r.row.extensions, boxMs: r.row.boxMs }));
  ok("#7761: the cut landed at the 20s ceiling, not at the 8s box and not past the ceiling",
    r.row && r.row.duration_ms >= CEILING_MS - 1500 && r.row.duration_ms < CEILING_MS + 4000,
    `duration ${r.row && r.row.duration_ms}ms`);
  ok(`#7761: the assigner heard exactly ${EXT_MAX} extension notices, the last one saying ${EXT_MAX}/${EXT_MAX}`,
    r.extended.filter(s => s.to === "sasha@mac").length === EXT_MAX
    && r.extended.some(s => new RegExp(`\\(${EXT_MAX}/${EXT_MAX}\\)`).test(s.text || "")),
    r.extended.map(s => s.text?.slice(0, 60)).join(" | "));
  ok("#7099: the ceiling cut's exit is the sweep's own signal, ledgered as cutSignal",
    r.row && !!r.row.cutSignal, JSON.stringify(r.row && { exit: r.row.exit, cutSignal: r.row.cutSignal }));
}

hub.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
