#!/usr/bin/env node
// trantor tests — hermetic (no network: RELAY_URL points at a closed port).
// Focus: the hook must ALWAYS emit valid JSON, even when injected handoff content
// contains control chars / U+2028 / quotes (the non-deterministic bug we hit).
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { drillEnv } from "./drill-env.mjs";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
const CLOSED = "http://127.0.0.1:1"; // refuses fast -> no network dependency
const runHook = (projDir, sess) => spawnSync("node", ["hooks/sessionstart.mjs"], {
  input: '{"source":"startup"}', encoding: "utf8", timeout: 15000,
  env: { ...drillEnv(), CLAUDE_PROJECT_DIR: projDir, RELAY_SESSION: sess, RELAY_URL: CLOSED },
});

const proj = "relay-selftest-" + process.pid;
const projDir = join(tmpdir(), proj);
const handoffDir = join(homedir(), ".agent-bus", "handoffs");
mkdirSync(handoffDir, { recursive: true });
const hfFile = join(handoffDir, `${proj}-9999999999.json`);

// Adversarial handoff: control chars, bell, line/paragraph separators, quotes, backslash, newline, emoji.
const nasty = "TASK" + String.fromCharCode(0x1f,0x07,0x00) + "ctrl " + String.fromCharCode(0x2028) + " LS " + String.fromCharCode(0x2029) + " PS " + String.fromCharCode(0x7f) + " DEL quoted backslash NEXT done <tag>";
writeFileSync(hfFile, JSON.stringify({
  id: `${proj}-9999999999`, project: projDir, projectName: proj,
  machine: "hostname", trigger: "manual", summary: nasty,
  gitStatus: "M file", transcript_path: "/tmp/x.jsonl", consumed: false,
}, null, 2));

console.log("# trantor tests");
const r = runHook(projDir, proj);
ok("hook exits 0", r.status === 0);

let parsed = null, valid = false;
try { parsed = JSON.parse(r.stdout); valid = true; } catch { valid = false; }
ok("hook stdout is VALID JSON despite adversarial handoff content", valid);
if (!valid) console.log("    raw stdout (first 160):", JSON.stringify(r.stdout.slice(0, 160)));

const ctx = parsed?.hookSpecificOutput?.additionalContext || "";
ok("injected the <trantor-handoff> block", ctx.includes("<trantor-handoff"));
ok("no raw control chars left in injected context",
   ![...ctx].some(ch => { const c = ch.codePointAt(0); return (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f || c === 0x2028 || c === 0x2029; }));
ok("handoff marked consumed after load",
   existsSync(hfFile) && JSON.parse(readFileSync(hfFile, "utf8")).consumed === true);

const r2 = runHook(projDir, proj);
let ctx2 = "";
try { ctx2 = JSON.parse(r2.stdout || "{}")?.hookSpecificOutput?.additionalContext || ""; } catch {}
ok("consumed handoff is NOT re-injected on next start", !ctx2.includes("trantor-handoff"));

// home-directory guard: a session opened in ~ itself must NOT register (it would
// spawn a phantom "<username>" project board) — unless RELAY_SESSION opts it in.
// drillEnv, not a two-name filter (#6108): a runner in a herdr pane also exports
// HERDR_PANE_ID/TRANTOR_ORCH, and the home child must see NONE of that identity.
const envSansOptIn = drillEnv();
const rh = spawnSync("node", ["hooks/sessionstart.mjs"], {
  input: '{"source":"startup"}', encoding: "utf8", timeout: 15000,
  env: { ...envSansOptIn, CLAUDE_PROJECT_DIR: homedir(), RELAY_URL: CLOSED },
});
ok("home-dir session exits 0", rh.status === 0);
// Was: assert stdout is exactly "{}". Silence was the bug (2026-08-23) — a reboot put every
// window in $HOME, each session assumed it was still its old seat, and one finally reported
// "Trantor is unreachable" with every hub healthy. The INVARIANT is unchanged (no registration,
// no phantom project); the session must now also be TOLD, so the output carries the not-a-seat
// block and never the registered-session block.
{
  let hctx = ""; try { hctx = JSON.parse(rh.stdout || "{}")?.hookSpecificOutput?.additionalContext || ""; } catch {}
  ok("home-dir session does not register — no phantom project", !hctx.includes("<trantor session="));
  ok("home-dir session is TOLD it is not a seat (not silent)", hctx.includes("<trantor-not-a-seat"));
}
ok("home-dir session says why on stderr", rh.stderr.includes("home directory"));
const rh2 = runHook(homedir(), "deliberate:home");
ok("RELAY_SESSION opts a home-dir session back in", rh2.status === 0 && !rh2.stderr.includes("not registering"));

// plugin-cache guard: verifying `node mcp.mjs` boots from a plugin snapshot is the documented
// check after an update, but PROJECT falls back to the cwd basename — so each check used to
// leave a lane named after the VERSION (a real "0.17.66" lane sat in the sidebar until 2026-08-12).
{
  // realpath: macOS tmpdir() is a symlink (/var -> /private/var) but process.cwd() reports the
  // real path, so a raw join() would never prefix-match. CLAUDE_PROJECT_DIR must be stripped too —
  // it OVERRIDES cwd, and this suite runs inside a Claude session that sets it.
  const cacheRoot = realpathSync(mkdirSync(join(tmpdir(), `tt-pcache-${process.pid}`), { recursive: true })
    || join(tmpdir(), `tt-pcache-${process.pid}`));
  const cacheDir = join(cacheRoot, "plugins", "cache", "trantor", "trantor", "9.9.9");
  mkdirSync(cacheDir, { recursive: true });
  const envSansDir = Object.fromEntries(Object.entries(envSansOptIn).filter(([k]) => k !== "CLAUDE_PROJECT_DIR"));
  const runMcp = (cwd, extra = {}) => spawnSync("node", [join(process.cwd(), "mcp.mjs")], {
    cwd, input: "", encoding: "utf8", timeout: 20000,
    env: { ...envSansDir, RELAY_URL: CLOSED, CLAUDE_CONFIG_DIR: cacheRoot, ...extra },
  });
  const rp = runMcp(cacheDir);
  // reason phrasing now comes from the ONE shared nonSeatReason() (lib/project.mjs), so the hook
  // and the MCP server can never disagree about what a seat is; it reads "the plugin cache".
  ok("a snapshot dir does NOT auto-register (no version-named phantom lane)", rp.stderr.includes("no auto-presence: the plugin cache"));
  ok("and it never even attempts the register call", !rp.stderr.includes("initial register failed"));
  ok("the relay server still starts, so tools stay callable", rp.stderr.includes("connected as"));
  const rp2 = runMcp(cacheDir, { RELAY_PROJECT: "deliberate" });
  ok("RELAY_PROJECT opts a snapshot dir back in", !rp2.stderr.includes("no auto-presence"));
  try { rmSync(cacheRoot, { recursive: true, force: true }); } catch {}
}

// --- regression: is-main guard must fire when the install path contains a SPACE ---
// Bug (0.17.24): bin/profile.mjs & bin/advise.mjs compared import.meta.url to a hand-built
// `file://${argv[1]}` (raw, unencoded). import.meta.url is percent-encoded, so a space in the path
// (e.g. ".../Application Support/..." — Herd's bundled nvm) made the guard false → main block skipped,
// exit 0, no write. The whole class: any URL-reserved char in the path. Fixed via pathToFileURL.
{
  // realpath the tmp base first: macOS tmpdir() lives under /var → /private/var (a symlink), which would
  // otherwise mismatch import.meta.url (realpath-resolved) vs argv1 for reasons unrelated to the space.
  const spBase = join(realpathSync(tmpdir()), `trantor sp ${process.pid}`); // NOTE: space in the path
  const spDir = join(spBase, "bin");
  mkdirSync(spDir, { recursive: true });
  for (const f of ["profile.mjs", "advise.mjs"]) {
    const dst = join(spDir, f);
    writeFileSync(dst, readFileSync(join(process.cwd(), "bin", f), "utf8"));
    // advise reads stdin; profile prints its table. Both must reach their main block & emit output.
    const r = spawnSync("node", [dst, f === "advise.mjs" ? "--demo" : "show"], {
      encoding: "utf8", timeout: 15000, env: { ...drillEnv(), HOME: join(spBase, "home") },
    });
    const ran = r.status === 0 && (r.stdout || "").trim().length > 0;
    ok(`${f} main block runs from a space-containing path (is-main guard encoded)`, ran);
  }
  // Prove the OLD idiom would have failed here (guards against a silent regression back to file://+argv1).
  const probe = join(spDir, "probe.mjs");
  writeFileSync(probe, 'console.log(import.meta.url === `file://${process.argv[1]}` ? "RAN" : "SKIPPED")');
  const rp = spawnSync("node", [probe], { encoding: "utf8", timeout: 8000 });
  ok("old `file://${argv1}` idiom DOES skip on a space path (so the fix is load-bearing)", rp.stdout.trim() === "SKIPPED");
  rmSync(spBase, { recursive: true, force: true });
}

// --- regression: sessionstart's hub reads must actually WORK against a live hub ---
// Bug (≤0.17.68): jget() called signedGet without importing it from ./lib/api.mjs. Every hub read
// (peers, catchup, board context) threw ReferenceError — swallowed by the callers' catch{}, so the
// hook exited 0 with its context injection silently EMPTY. The closed-port tests above can't see
// this class (network failure and a ReferenceError look identical there), so: live hub, real read.
{
  const { spawn } = await import("node:child_process");
  const PORT = 47911;
  const hubDir = join(realpathSync(tmpdir()), `trantor-ss-live-${process.pid}`);
  mkdirSync(hubDir, { recursive: true });
  const hub = spawn("node", ["hub.mjs"], { env: { ...drillEnv(), RELAY_PORT: String(PORT), RELAY_DATA_DIR: hubDir, RELAY_HOST: "127.0.0.1" }, stdio: "ignore" });
  try {
    await new Promise(r => setTimeout(r, 900));
    const sess = `livetest:${proj}`;
    // a SECOND live session in the same project makes the hook render its peers block — which only
    // happens if jget('/peers') returns real data instead of throwing
    await fetch(`http://127.0.0.1:${PORT}/register`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: `other:${proj}`, project: proj }) });
    const r2 = spawnSync("node", ["hooks/sessionstart.mjs"], {
      input: '{"source":"startup"}', encoding: "utf8", timeout: 15000,
      env: { ...drillEnv(), CLAUDE_PROJECT_DIR: projDir, RELAY_SESSION: sess, RELAY_URL: `http://127.0.0.1:${PORT}` },
    });
    let ctx = "";
    try { ctx = JSON.parse(r2.stdout)?.hookSpecificOutput?.additionalContext || ""; } catch {}
    ok("sessionstart reads a LIVE hub (peers block rendered — signedGet import intact)", ctx.includes(`other:${proj}`));
    ok("sessionstart live run has no ReferenceError on stderr", !/ReferenceError|is not defined/.test(r2.stderr || ""));

    // grants injection: an APPROVED proposal must reach every future session's context
    const fp = await fetch(`http://127.0.0.1:${PORT}/propose`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sess, project: proj, scope: "grant-inject probe", condition: "always in this test", exclusions: "nothing else" }) }).then(r => r.json());
    await fetch(`http://127.0.0.1:${PORT}/proposal/decide`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: fp.proposal.id, status: "approved", by: "owner@test" }) });
    const r3 = spawnSync("node", ["hooks/sessionstart.mjs"], {
      input: '{"source":"startup"}', encoding: "utf8", timeout: 15000,
      env: { ...drillEnv(), CLAUDE_PROJECT_DIR: projDir, RELAY_SESSION: sess, RELAY_URL: `http://127.0.0.1:${PORT}` },
    });
    let ctx3 = "";
    try { ctx3 = JSON.parse(r3.stdout)?.hookSpecificOutput?.additionalContext || ""; } catch {}
    ok("an approved GRANT is injected into the next session's context", ctx3.includes("<trantor-grants") && ctx3.includes("grant-inject probe"));
  } finally { hub.kill(); rmSync(hubDir, { recursive: true, force: true }); }
}

rmSync(hfFile, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
