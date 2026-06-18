#!/usr/bin/env node
// trantor tests — hermetic (no network: RELAY_URL points at a closed port).
// Focus: the hook must ALWAYS emit valid JSON, even when injected handoff content
// contains control chars / U+2028 / quotes (the non-deterministic bug we hit).
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`); cond ? pass++ : fail++; };
const CLOSED = "http://127.0.0.1:1"; // refuses fast -> no network dependency
const runHook = (projDir, sess) => spawnSync("node", ["hooks/sessionstart.mjs"], {
  input: '{"source":"startup"}', encoding: "utf8", timeout: 15000,
  env: { ...process.env, CLAUDE_PROJECT_DIR: projDir, RELAY_SESSION: sess, RELAY_URL: CLOSED },
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
const envSansOptIn = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "RELAY_SESSION" && k !== "RELAY_PROJECT"));
const rh = spawnSync("node", ["hooks/sessionstart.mjs"], {
  input: '{"source":"startup"}', encoding: "utf8", timeout: 15000,
  env: { ...envSansOptIn, CLAUDE_PROJECT_DIR: homedir(), RELAY_URL: CLOSED },
});
ok("home-dir session exits 0", rh.status === 0);
ok("home-dir session emits {} — no registration, no phantom project", rh.stdout.trim() === "{}");
ok("home-dir session says why on stderr", rh.stderr.includes("home directory"));
const rh2 = runHook(homedir(), "deliberate:home");
ok("RELAY_SESSION opts a home-dir session back in", rh2.status === 0 && !rh2.stderr.includes("not registering"));

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
      encoding: "utf8", timeout: 15000, env: { ...process.env, HOME: join(spBase, "home") },
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

rmSync(hfFile, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
