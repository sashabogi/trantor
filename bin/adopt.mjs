#!/usr/bin/env node
// `trantor adopt` — take over a session that is already running in a Terminal.
//
// You cannot move a running pty into herdr. That is the wall this hits, and it is not going away.
// But the pty was never the valuable part: the CONVERSATION is, and that lives in a transcript on
// disk. So adopting is a two-step move — learn which session id is live, then reopen THAT
// conversation inside Trantor with --resume. The terminal changes; the thread does not.
//
// Which session is live cannot be read from the process: macOS does not expose another process's
// environment, so CLAUDE_CODE_SESSION_ID is unreachable. The transcript's modification time is the
// evidence we do have, and it is good evidence but not proof — a session that just ended and one
// still running look similar for a minute. So this SHOWS the candidates and defaults to the
// newest, rather than asserting which one is yours.
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { resolveProject, writeOrchSession } from "../lib/project.mjs";

const D = "\x1b[2m", B = "\x1b[1m", Y = "\x1b[33m", G = "\x1b[32m", R = "\x1b[0m";
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const project = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--session")
  || resolveProject(process.cwd());
const devRoot = process.env.TRANTOR_DEV_ROOT || join(homedir(), "development");
const dir = join(devRoot, project);
if (!existsSync(dir)) {
  console.error(`no local checkout for ${project} (looked in ${devRoot})`);
  process.exit(1);
}

/** claude keeps a project's transcripts under a slug of its working directory. */
const slug = dir.replace(/[/.]/g, "-");
const tdir = join(homedir(), ".claude", "projects", slug);
if (!existsSync(tdir)) {
  console.error(`no claude sessions have ever run in ${dir}`);
  process.exit(1);
}

const RECENT_MS = 60 * 60 * 1000;
const now = Date.now();
const candidates = readdirSync(tdir)
  .filter(f => f.endsWith(".jsonl"))
  .map(f => {
    const p = join(tdir, f);
    const st = statSync(p);
    return { id: f.replace(/\.jsonl$/, ""), mtime: st.mtimeMs, size: st.size };
  })
  .filter(c => now - c.mtime < RECENT_MS)
  .sort((a, b) => b.mtime - a.mtime);

if (!candidates.length) {
  console.error(`no session has written to ${project} in the last hour — nothing to adopt`);
  console.error(`${D}start a fresh one instead: trantor open ${project}${R}`);
  process.exit(1);
}

const chosen = flag("--session") || candidates[0].id;
if (!candidates.some(c => c.id === chosen) && flag("--session")) {
  console.error(`${chosen} has not written to ${project} recently`);
  process.exit(1);
}

const ago = (ms) => { const s = Math.round((now - ms) / 1000); return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };
const kb = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.round(n / 1e3)}KB`);

console.log(`${B}adopt${R} · ${project}`);
for (const c of candidates.slice(0, 5)) {
  const mark = c.id === chosen ? `${G}→${R}` : " ";
  console.log(`  ${mark} ${c.id}  ${D}${ago(c.mtime).padEnd(9)} ${kb(c.size)}${R}`);
}
if (candidates.length > 1) {
  console.log(`${D}the newest is assumed to be yours; pick another with --session <id>${R}`);
}

// Record it where `trantor open` looks. One choke point for the map (writeOrchSession) so every
// rewrite is attributable in orch-sessions.log — adopt is one of the map's three writers
// (SYSTEM-CONTRACT §4), and until 2026-08-30 it wrote the file by hand, invisibly.
writeOrchSession(project, chosen, "adopt");
console.log(`\n${G}recorded${R} ${chosen} as ${project}'s orchestrator session`);

// Two live claudes on one transcript is the one thing that must not happen: they would interleave
// writes into the same file. So say plainly what has to happen first.
let running = [];
try {
  const pids = execFileSync("/usr/bin/pgrep", ["-x", "claude"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const pid of pids) {
    try {
      const out = execFileSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-p", pid, "-Fn"], { encoding: "utf8" });
      if (out.split("\n").some(l => l.startsWith("n") && l.slice(1) === dir)) running.push(pid);
    } catch { /* process went away between listing and asking */ }
  }
} catch { /* nothing running */ }

if (running.length) {
  console.log(`\n${Y}A claude is still running in ${dir} (pid ${running.join(", ")}).${R}`);
  console.log(`Quit that window first — two sessions writing one transcript will corrupt the thread.`);
  console.log(`Then: ${B}cd ${dir} && trantor open${R}`);
} else {
  console.log(`\nNothing is running there. Continue it in Trantor with:`);
  console.log(`  ${B}cd ${dir} && trantor open${R}`);
}
