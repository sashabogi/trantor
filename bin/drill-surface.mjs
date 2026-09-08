#!/usr/bin/env node
// `trantor drill` — the §7 end-to-end SEAM drill (SYSTEM-CONTRACT.md; Phase 5 of the reassembly).
//
// Unit suites passing while the seams fail is this project's most-repeated lesson. This drill
// runs the REAL components against each other on a throwaway project: a real herdr workspace,
// a real Claude session, the real socket transport the app uses, the real hooks, the real
// handoff machine — and asserts on evidence (transcript rows, herdr state, ledger files),
// never on exit codes alone.
//
// It is the ship gate for desktop/chat/handoff/crew changes: run it before every such release;
// a red drill does not ship. (There is no scripted release path to wire it into — the release
// dance is manual — so the gate is this command plus the contract that mandates it.)
//
// Flags: --keep leaves the scratch world AND workspace for inspection.
// Failed runs retain disk evidence after closing their workspace. No app build/install.
// TRANTOR_DRILL_RESULT overrides ~/.agent-bus/drill-result.json (crew seats use .agent-bus-out).
// TRANTOR_DRILL_APP selects an existing app executable; TRANTOR_DRILL_WORLD selects scratch cwd.

import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync, execSync, spawn } from "node:child_process";
import { createConnection } from "node:net";

import { pathToFileURL } from "node:url";
import { DrillReport } from "./drill-report.mjs";
import { sessionContext } from "../hooks/lib/api.mjs";
import { runAppDrills, crewWorkspaceDrill, checkSocketHome } from "./drill-seams.mjs";
import { shellQuote } from "./crew/core.mjs";

// One ownership map. Shared steps must finish before ANY card they cover can close.
export const CARD_STEPS = {
  6799: { steps: ["S0", "S1", "S2", "S3", "S4", "S5"], autoClose: false },
  6533: { steps: ["S6-ask"], autoClose: true },
  6668: { steps: ["S6-handoff"], autoClose: true },
  6317: { steps: ["S6-key-post", "S6-key-throw"], autoClose: true },
  6667: { steps: ["S4b", "S7"], autoClose: true },
  6587: { steps: ["S8"], autoClose: false, recipe: "needs live duty probe: operator removes the trantor/trantor-duty link, DMs the idle orchestrator, and checks for a socket nudge within 3 minutes" },
  6481: { steps: ["S9"], autoClose: true },
  6483: { steps: ["S10"], autoClose: false, recipe: "covered by Drill Mode (#6800): operator checks Accounts with the CLI below the app minimum, then restores the CLI" },
};

export function findHandoff(dir, project) {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(`${project}-`) || !name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const record = JSON.parse(readFileSync(file, "utf8"));
      // relay_handoff can arrive before the hook ledger. Keep polling until states exist.
      if (Array.isArray(record?.states) && record.states.length) return file;
    } catch { /* A hook may still be writing this record; try it on the next poll. */ }
  }
  return null;
}

export async function main() {
const KEEP = process.argv.includes("--keep");
const G = "\x1b[32m", Rd = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", R = "\x1b[0m";
let pass = 0, fail = 0, skip = 0;
const context = sessionContext();
const output = resolve(process.env.TRANTOR_DRILL_RESULT || join(process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"), "drill-result.json"));
const report = new DrillReport(CARD_STEPS, output, context);
let currentStep = null;
const PASS = (s, ev = "") => { pass++; report.record(currentStep, "pass", s, ev); console.log(`  ${G}PASS${R}  ${s} [${report.cardsFor(currentStep).map(id => `#${id}`).join(", ")}]${ev ? `  ${D}${ev}${R}` : ""}`); };
const FAIL = (s, ev = "") => { fail++; report.record(currentStep, "fail", s, ev); console.log(`  ${Rd}FAIL${R}  ${s} [${report.cardsFor(currentStep).map(id => `#${id}`).join(", ")}]${ev ? `  ${D}${ev}${R}` : ""}`); };
const SKIP = (s, why) => { skip++; report.record(currentStep, "skip", s, why); console.log(`  ${Y}SKIP${R}  ${s}  ${D}${why}${R}`); };
const step = (n) => {
  if (currentStep) report.complete(currentStep);
  currentStep = n.split(" ")[0];
  console.log(`\n${n}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function herdr(args, { json = true } = {}) {
  const out = execFileSync("herdr", args, { encoding: "utf8", timeout: 90_000 });
  return json ? JSON.parse(out) : out;
}

/** One request over herdr's socket — byte-identical to the app's transport (herdr.rs). */
function socketRequest(req, timeoutMs = 90_000) {
  const sockPath = join(homedir(), ".config", "herdr", "herdr.sock");
  return new Promise((resolve, reject) => {
    const s = createConnection(sockPath);
    const t = setTimeout(() => { s.destroy(); reject(new Error("socket timeout")); }, timeoutMs);
    let buf = "";
    s.on("connect", () => s.write(JSON.stringify(req) + "\n"));
    s.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) { clearTimeout(t); s.destroy(); resolve(buf.slice(0, nl)); }
    });
    s.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function waitFor(desc, fn, { timeoutMs = 60_000, everyMs = 1_000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

function transcriptDirFor(projDir) {
  return join(homedir(), ".claude", "projects", String(projDir).replace(/[/.]/g, "-"));
}
function newestJsonl(dir) {
  try {
    return readdirSync(dir).filter(f => f.endsWith(".jsonl"))
      .map(f => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0]?.f || null;
  } catch { return null; }
}
function userTurnsContaining(file, needle) {
  const hits = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r?.type !== "user") continue;
    const c = r.message?.content;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: JSONL content is a wire union of text or content blocks; this is its decode boundary.
    const t = typeof c === "string" ? c
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: Untrusted JSONL blocks must be objects with type=text before reading their text field.
      : Array.isArray(c) ? c.map(b => (b && typeof b === "object" && b.type === "text") ? b.text : "").join(" ") : "";
    if (t.includes(needle)) hits.push(t);
  }
  return hits;
}
function assistantSaid(file, needle) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r?.type !== "assistant") continue;
    for (const b of r.message?.content || []) {
      if (b && b.type === "text" && String(b.text).includes(needle)) return true;
    }
  }
  return false;
}


/** Start a Claude agent in a pane, answering the folder-trust dialog if it blocks startup
 *  (the P0b recovery: agent_not_ready keeps the name live; one enter accepts the fresh dir). */
async function startClaude(name, paneId) {
  // Run in the pane shell: herdr agent start restores the server's child-session flag.
  herdr(["pane", "run", paneId, "env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION claude"], { json: false });
  let trusted = false;
  const settled = await waitFor("startup", () => {
    const screen = herdr(["pane", "read", paneId], { json: false });
    if (!trusted && screen.includes("Yes, I trust this")) {
      // New Claude versions default to No. Answer ONLY this drill-owned folder dialog.
      const keys = /❯\s*No, exit/.test(screen) ? ["down", "enter"] : ["enter"];
      herdr(["pane", "send-keys", paneId, ...keys], { json: false });
      trusted = true;
    }
    try {
      const status = herdr(["agent", "get", paneId]).result?.agent?.agent_status;
      return status === "idle" ? status : null;
    } catch { return null; }
  }, { timeoutMs: 45000, everyMs: 1500 });
  return settled || "not-ready";
}

// ---------- S0 · version skew ----------
step("S0 · version skew (hooks vs CLI vs app)");
{
  const cli = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version;
  let plugin = "?";
  try {
    // The plugin cache keeps one directory per version; the newest is what sessions load.
    const cache = join(homedir(), ".claude", "plugins", "cache", "trantor", "trantor");
    plugin = readdirSync(cache).filter(v => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => { const A = a.split(".").map(Number), B = b.split(".").map(Number); return (A[0]-B[0]) || (A[1]-B[1]) || (A[2]-B[2]); })
      .pop() || "?";
  } catch {}
  let app = "?";
  try { app = execSync('plutil -extract CFBundleShortVersionString raw "/Applications/Trantor.app/Contents/Info.plist"', { encoding: "utf8" }).trim(); } catch {}
  console.log(`  ${D}cli ${cli} · plugin ${plugin} · app ${app}${R}`);
  if (plugin === "?") {
    SKIP("hook/CLI version skew", "plugin hook version unreadable");
  } else if (plugin !== cli) {
    FAIL("hook/CLI version skew", `plugin ${plugin} vs CLI ${cli}`);
  } else {
    PASS("no hook/CLI version skew", `${cli}`);
  }
  globalThis.__skew = plugin !== "?" && plugin !== cli;
}

// ---------- world ----------
// NOT tmpdir(): macOS tmp is a /var symlink and Claude records the /private/var realpath,
// so the transcript-slug lookup would miss. A dot-dir under $HOME has no such alias.
const scratch = join(process.cwd(), ".agent-bus-out");
mkdirSync(scratch, { recursive: true });
const world = process.env.TRANTOR_DRILL_WORLD
  ? resolve(process.env.TRANTOR_DRILL_WORLD) : mkdtempSync(`${scratch}/`);
checkSocketHome(world);
const proj = join(world, context.project);
const bus = join(world, ".agent-bus");
mkdirSync(proj, { recursive: true });
mkdirSync(join(bus, "handoffs"), { recursive: true });
mkdirSync(join(world, ".config", "herdr"), { recursive: true });
symlinkSync(join(homedir(), ".config", "herdr", "herdr.sock"), join(world, ".config", "herdr", "herdr.sock"));
execFileSync("git", ["init", "-q"], { cwd: proj });
// The drill's handoff phase exercises the AUTO chain deliberately; the shipped default is ask.
writeFileSync(join(bus, "autonomy.json"), JSON.stringify({ version: 1, defaults: { baton: "auto" }, projects: {} }));
const projectName = basename(proj);
const tDir = transcriptDirFor(proj);

let ws = null, pane = null;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  if (KEEP) { console.log(`\n${D}--keep: world at ${world} · workspace ${ws?.workspace_id || "?"} left open${R}`); return; }
  try { if (pane) herdr(["agent", "prompt", pane, "/exit"], { json: true }); } catch {}
  try { if (ws) herdr(["workspace", "close", ws.workspace_id], { json: true }); } catch {}
  if (fail > 0) { console.log(`failed-run evidence retained at ${world}`); return; }
  try { rmSync(world, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  if (currentStep) FAIL("drill interrupted", signal);
  cleanup();
  process.exit(signal === "SIGINT" ? 130 : 143);
});

try {
// ---------- S1 · cold start ----------
step("S1 · cold start: workspace, clean env, agent, transcript EXISTS");
try {
  const created = herdr(["workspace", "create", "--cwd", proj, "--label", "tt-drill"]);
  ws = { workspace_id: created.result.workspace.workspace_id };
  pane = created.result.root_pane.pane_id;
  writeFileSync(join(bus, "crew-windows.txt"), `${projectName}\therdrws\t__ws__\t${ws.workspace_id}\n${projectName}\torch\torchestrator\t${pane}\n`);
  PASS("throwaway herdr workspace", `${ws.workspace_id} pane ${pane}`);
  // The P0b trap, prevented at the source: a pane inheriting CLAUDE_CODE_CHILD_SESSION runs
  // Claude with transcript saving OFF — an invisible session. Every spawn path must clear it.
  herdr(["pane", "run", pane,
    `unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION RELAY_SESSION RELAY_AGENT TRANTOR_ORCH TRANTOR_SEAT; export RELAY_PROJECT=${projectName} AGENT_BUS_DIR=${bus} RELAY_URL=http://127.0.0.1:1 ` +
    `TRANTOR_NO_SCROOGE=1 TRANTOR_NO_HANDOFF_SPAWN=1 TRANTOR_NO_BALANCE_CHECK=1 ` +
    `RELAY_CONTEXT_WARN_FRAC=0.000001 RELAY_STOP_TIMEOUT_MS=300 RELAY_CONTEXT_WINDOW=1000000; echo ENV-READY`], { json: false });
  await sleep(1500);
  const st = await startClaude("drill", pane);
  if (st === "idle") PASS("claude starts and settles idle (trust dialog auto-answered if shown)");
  else FAIL("claude starts and settles idle", String(st));
} catch (e) {
  FAIL("S1 world setup", String(e.message || e).slice(0, 160));
  console.log(`\n${Rd}cannot continue without S1${R}`);
  throw e;
}

// ---------- S2 · transport ----------
step("S2 · transport: whole multiline message through the app's exact socket call");
const MARK = `drill-${Date.now() % 100000}`;
{
  const text = `-leading dash line for ${MARK}.\nSecond line with /tmp/fake.png mid-sentence.\nReply with exactly ${MARK}-OK and nothing else.`;
  const raw = await socketRequest({ id: "trantor:agent.prompt", method: "agent.prompt", params: { target: pane, text } });
  const resp = JSON.parse(raw);
  if (resp.result?.type === "agent_prompted") PASS("agent.prompt accepted (no keystrokes involved)");
  else FAIL("agent.prompt accepted", raw.slice(0, 120));

  const tfile = await waitFor("transcript exists", () => newestJsonl(tDir), { timeoutMs: 10_000, everyMs: 500 });
  if (tfile) PASS("transcript EXISTS within seconds (CLAUDE_CODE_CHILD_SESSION trap absent)", basename(tfile));
  else FAIL("transcript EXISTS within seconds — invisible-session trap?");

  if (tfile) {
    const replied = await waitFor("reply", () => assistantSaid(tfile, `${MARK}-OK`) || null, { timeoutMs: 120_000, everyMs: 2_000 });
    const turns = userTurnsContaining(tfile, MARK);
    if (turns.length === 1 && turns[0].includes("\n") && turns[0].startsWith("-leading"))
      PASS("ONE user turn, newlines intact, dash-leading text unmangled");
    else FAIL("ONE whole user turn", `turns=${turns.length}`);
    if (replied) PASS("the reply came back");
    else FAIL("the reply came back");
  }
}

// ---------- S3 · identity ----------
step("S3 · identity: the pane itself names the session (Phase 2)");
let predecessorSid = null;
{
  const got = herdr(["agent", "get", pane]);
  const as = got.result?.agent?.agent_session;
  const tfile = newestJsonl(tDir);
  predecessorSid = as?.kind === "id" ? as.value : null;
  if (predecessorSid && tfile && basename(tfile) === `${predecessorSid}.jsonl`)
    PASS("pane report matches the live transcript", predecessorSid.slice(0, 8));
  else if (!as) FAIL("pane reports its session — is the herdr claude integration installed?");
  else FAIL("pane report matches the live transcript", `${as?.value?.slice(0, 8)} vs ${tfile && basename(tfile).slice(0, 8)}`);
}

// ---------- S4 · the handoff machine ----------
step("S4 · handoff machine: warn → arm → fire → WRITTEN → successor claims → RECAPPED");
{
  // A turn that uses a tool: the heartbeat is PostToolUse, so only tool use can arm the baton.
  // The heartbeat is PostToolUse: only a REAL tool call can arm the baton. Models sometimes
  // answer without the tool (observed: run 2 of 3 on 2026-08-30 — 1-in-3 prompt fragility,
  // not a seam), so ask, verify tool use in the transcript, and re-ask up to twice.
  let handoffFile = null;
  for (let attempt = 1; attempt <= 3 && !handoffFile; attempt++) {
    const raw = await socketRequest({ id: "trantor:agent.prompt", method: "agent.prompt", params: {
      target: pane, text: `You MUST call the Bash tool now and run exactly: pwd — do not answer without calling it. Then reply with just DONE-S4-${attempt}.` } });
    if (JSON.parse(raw).result?.type !== "agent_prompted") { FAIL("S4 prompt accepted", raw.slice(0, 100)); break; }
    handoffFile = await waitFor("handoff written", () => findHandoff(join(bus, "handoffs"), projectName), { timeoutMs: 120_000, everyMs: 2_000 });
    if (!handoffFile) console.log(`  ${D}attempt ${attempt}: no handoff yet — re-asking with the tool requirement${R}`);
  }
  if (!handoffFile) {
    FAIL("the armed baton fired and WROTE a handoff at the turn boundary");
  } else {
    const rec = JSON.parse(readFileSync(handoffFile, "utf8"));
    const states = (rec.states || []).map(s => s.state);
    if (states[0] === "written") PASS("§5 ledger opens with WRITTEN", `${basename(handoffFile)}`);
    else FAIL("§5 ledger opens with WRITTEN", states.join(","));

    // Successor: end the predecessor, start fresh in the SAME pane — the claim is sessionstart's.
    try { herdr(["agent", "prompt", pane, "/exit"]); } catch {}
    await sleep(4000);
    const st2 = await startClaude("drill2", pane);
    if (st2 !== "idle") FAIL("successor claude starts", String(st2));
    const claimed = await waitFor("claimed on ledger", () => {
      try {
        const r = JSON.parse(readFileSync(handoffFile, "utf8"));
        return (r.states || []).some(s => s.state === "claimed") ? r : null;
      } catch { return null; }
    }, { timeoutMs: 60_000, everyMs: 2_000 });
    if (claimed) PASS("successor CLAIMED it (sessionstart, on the ledger)", `by ${claimed.states.find(s => s.state === "claimed")?.by?.slice(0, 8)}`);
    else FAIL("successor CLAIMED it");

    const stamp = () => {
      try { return readdirSync(join(bus, "handoffs")).find(f => f.startsWith("recap-pending-")); } catch { return null; }
    };
    if (stamp()) PASS("recap net armed (pending stamp exists)");
    else FAIL("recap net armed (pending stamp exists)");

    const raw2 = await socketRequest({ id: "trantor:agent.prompt", method: "agent.prompt", params: {
      target: pane, text: "Say only: ACK-S4" } });
    if (JSON.parse(raw2).result?.type !== "agent_prompted") FAIL("successor prompt accepted", raw2.slice(0, 100));
    const recapped = await waitFor("recapped", () => {
      try {
        const r = JSON.parse(readFileSync(handoffFile, "utf8"));
        return (r.states || []).some(s => s.state === "recapped") && !stamp() ? r : null;
      } catch { return null; }
    }, { timeoutMs: 120_000, everyMs: 2_000 });
    if (recapped) PASS("first Stop recorded RECAPPED and cleared the net", recapped.states.map(s => s.state).join("→"));
    else FAIL("first Stop recorded RECAPPED and cleared the net", stamp() ? "stamp still present" : "no recapped state");
  }
}

if (globalThis.__skew && fail > 0) {
  console.log(`  ${Y}NOTE${R}  S4 runs the INSTALLED plugin's hooks — with the skew above, ledger/recap failures are expected until the newer CLI is published and \`claude plugin update trantor@trantor\` runs.`);
}

// ---------- S4b · the --baton pane leg (#5643) ----------
// The CLI-side replacement chain: a MANUAL handoff on disk, then bin/baton-pane.mjs (the detached
// driver spawnBaton arms for hosted panes) replaces the pane's session in place — idle gate,
// graceful end, reopen, kickoff — and the successor claims AND recaps with no human prompt.
// The reopen is overridden to stay inside this drill's herdr world; the chain is otherwise the
// production one. The routing itself (spawnBaton → driver, never a window) is drilled hermetically
// in test-handoff.mjs.
step("S4b · --baton pane leg: the driver replaces the session in place, kickoff recaps it");
{
  let st0 = null;
  try { st0 = herdr(["agent", "get", pane]).result?.agent?.agent_status || null; } catch {}
  if (!st0) {
    SKIP("--baton pane leg", "no live agent in the pane (S4 did not leave a successor)");
  } else {
    let hf = null;
    try {
      const wh = execFileSync(process.execPath, [join(import.meta.dirname, "write-handoff.mjs")], {
        input: "# handoff\nS4b: the pane leg drill — recap me.", encoding: "utf8", timeout: 30_000,
        env: { ...process.env, RELAY_PROJECT: projectName, RELAY_SESSION: "", RELAY_AGENT: "", TRANTOR_ORCH: "", RELAY_URL: "http://127.0.0.1:1", CLAUDE_PROJECT_DIR: proj, AGENT_BUS_DIR: bus, TRANTOR_NO_HANDOFF_SPAWN: "1", TRANTOR_NO_BATON_SPAWN: "1" },
      });
      hf = /handoff saved: (\S+\.json)/.exec(wh)?.[1] || null;
    } catch (e) { FAIL("S4b manual handoff written", String(e.message || e).slice(0, 120)); }
    if (hf) {
      PASS("manual handoff written for the pane to carry", basename(hf));
      const child = spawn(process.execPath, [join(import.meta.dirname, "baton-pane.mjs"),
        "--project", proj, "--handoff", hf, "--pane", pane], {
        env: { ...process.env, HOME: world, TRANTOR_DEV_ROOT: world, RELAY_PROJECT: projectName, RELAY_SESSION: "", RELAY_AGENT: "", TRANTOR_ORCH: "", RELAY_URL: "http://127.0.0.1:1", AGENT_BUS_DIR: bus, TRANTOR_BATON_IDLE_DEADLINE_S: "90",
          TRANTOR_BATON_REOPEN: `${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dirname, "cli.mjs"))} open ${shellQuote(projectName)}` },
        stdio: "ignore",
      });
      const exited = new Promise(res => child.on("exit", c => res(c)));
      // Environment noise, not the leg: a fresh session may block on the trust dialog; answer it
      // the way startClaude does so the kickoff has someone to land on.
      const watcher = (async () => {
        for (let i = 0; i < 40; i++) {
          await sleep(3000);
          try {
            const g = herdr(["agent", "get", pane]);
            const st = g.result?.agent?.agent_status;
            if (st === "blocked") herdr(["agent", "send-keys", pane, "enter"]);
            if (st === "idle") break;
          } catch {}
        }
      })();
      let timer;
      const code = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve("timeout"), 180_000); })]);
      clearTimeout(timer);
      if (code === "timeout") child.kill("SIGTERM");
      await watcher;
      if (code === 0) PASS("driver ran the whole chain (idle gate → graceful end → reopen → kickoff)");
      else FAIL("driver ran the whole chain", `exit ${code} — see ${join(bus, "logs")}/baton-pane-*.log`);
      const rec = await waitFor("S4b claimed+recapped", () => {
        try {
          const r = JSON.parse(readFileSync(hf, "utf8"));
          const s = (r.states || []).map(x => x.state);
          return s.includes("claimed") && s.includes("recapped") ? r : null;
        } catch { return null; }
      }, { timeoutMs: 120_000, everyMs: 2_000 });
      if (rec) PASS("successor claimed AND recapped — kicked off by the driver, no human prompt",
        rec.states.map(s => s.state).join("→"));
      else {
        let states = "unreadable";
        try { states = JSON.parse(readFileSync(hf, "utf8")).states?.map(s => s.state).join(",") || "none"; } catch {}
        FAIL("successor claimed AND recapped without a human prompt", states);
      }
    }
  }
}

// ---------- S5 · takeover ----------
step("S5 · takeover from a Terminal session");
SKIP("takeover chain", "needs an interactive Terminal-window session; proven live 2026-08-28 (0.18.13 drill) — automate in drill v2");

} catch (error) {
  FAIL("seam interrupted", error.message);
}

const run = async (name, fn) => {
  step(name);
  try { PASS(name, await fn()); } catch (error) { FAIL(name, error.message); }
};
await runAppDrills({ world, proj, bus, project: projectName, pane, workspace: ws?.workspace_id, run });
await run("S7 · reopen-race", async () => {
  // S4b records the production driver log plus successor claim. A rerun cannot reuse an old log.
  const logs = readdirSync(join(bus, "logs")).filter(name => name.startsWith("baton-pane-"));
  const trace = logs.map(name => readFileSync(join(bus, "logs", name), "utf8")).join("\n");
  const handoff = /armed: .*handoff=(\S+)/.exec(trace)?.[1];
  const record = handoff && JSON.parse(readFileSync(join(bus, "handoffs", handoff), "utf8"));
  const ended = /^(\S+) ended pid /m.exec(trace)?.[1];
  const reopened = /^(\S+) reopen starting via:/m.exec(trace)?.[1];
  const elapsed = Date.parse(reopened) - Date.parse(ended);
  if (!record?.states?.some(row => row.state === "claimed") || !trace.includes("reopen result: status=0")
      || !trace.includes("agent drop dropped") || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > 1000)
    throw new Error(`no complete sub-second end/drop/reopen/claim proof; elapsed=${elapsed}; ${trace.trim().slice(-700)}`);
  return `${handoff} claimed; reopen after ${elapsed}ms; ${trace.trim().split("\n").join("; ")}`;
});
step("S8 · duty wake-chain");
SKIP("duty wake-chain", CARD_STEPS[6587].recipe);
await run("S9 · crew workspace ownership", () => crewWorkspaceDrill({ proj, workspace: ws?.workspace_id }));
step("S10 · provider CLI source");
SKIP("provider CLI source", CARD_STEPS[6483].recipe);
if (currentStep) report.complete(currentStep);
if (!await report.closePassed()) fail++;
console.log(`\nresult: ${output}`);
console.log(JSON.stringify(report.results(), null, 2));
cleanup();
// ---------- verdict ----------
console.log(`\n${fail === 0 ? G + "DRILL GREEN" : Rd + "DRILL RED"}${R} — ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exitCode = fail === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
