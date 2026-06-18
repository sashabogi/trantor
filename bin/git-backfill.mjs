#!/usr/bin/env node
// trantor backfill — bridge GIT history → the board. Solo work that was committed but never carded
// (no crew, no TodoWrite) is invisible on the board; this turns it into done-cards so the project's
// living record reflects what actually happened. Commits are grouped by feature THEME (conventional-
// commit scope `feat(x):` → "x", or a "Prefix:" → the prefix), one done-card per theme placed at its
// latest commit time (so it slots into the FLOW timeline correctly). Idempotent: skips titles already
// on the board. Usage: trantor backfill [--since "14 days ago"] [--project <p>] [--dry-run]
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject, hostId } from "../lib/project.mjs";

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const c = join(homedir(), ".agent-bus", "config.json"); if (existsSync(c)) { const u = JSON.parse(readFileSync(c, "utf8")).url; if (u) return u; } } catch {}
  return "http://127.0.0.1:4477";
}
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
const dir = process.cwd();
const project = arg("project", resolveProject(dir));
const since = arg("since", "14 days ago");
const dry = args.includes("--dry-run");
const url = relayUrl();
const me = `${hostId()}:${project}`;

const themeOf = (s) => {
  let m;
  if ((m = s.match(/^[a-z]+\(([^)]+)\)\s*:/i))) return m[1].trim();           // feat(engine): → engine
  if ((m = s.match(/^([A-Za-z][\w &+/.]*?)\s*:/))) return m[1].trim();        // "Landing: …" → Landing
  if ((m = s.match(/^([A-Za-z][\w.+-]*)/))) return m[1];                      // first word
  return "misc";
};

let rows = [];
try {
  rows = execSync(`git -C ${JSON.stringify(dir)} log --since=${JSON.stringify(since)} --format=%H%x09%ct%x09%s`,
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n").filter(Boolean);
} catch (e) { console.error(`git log failed: ${e.message}`); process.exit(1); }
if (!rows.length) { console.log(`no commits since "${since}" in ${dir}`); process.exit(0); }

const groups = new Map();
for (const r of rows) {
  const [hash, ct, ...rest] = r.split("\t");
  const subject = rest.join("\t");
  const key = themeOf(subject).slice(0, 32);
  if (!groups.has(key)) groups.set(key, { commits: [], latest: 0 });
  const g = groups.get(key); const ms = Number(ct) * 1000;
  g.commits.push({ hash, ts: ms, subject }); if (ms > g.latest) g.latest = ms;
}

let existing = new Set();
try { const t = (await (await fetch(`${url}/tasks?project=${encodeURIComponent(project)}`)).json()).tasks || []; existing = new Set(t.map(x => x.title)); } catch {}

const ents = [...groups.entries()].sort((a, b) => a[1].latest - b[1].latest);
let posted = 0, skipped = 0;
for (const [theme, g] of ents) {
  const latest = g.commits.sort((a, b) => b.ts - a.ts)[0];
  const subj = latest.subject.replace(/^[a-z]+\([^)]*\)\s*:\s*/i, "").replace(/^[A-Za-z][\w &+/.]*?:\s*/, "").slice(0, 70);
  const title = `${theme}: ${subj}${g.commits.length > 1 ? ` (+${g.commits.length - 1} more)` : ""}`.slice(0, 190);
  if (existing.has(title)) { skipped++; continue; }
  if (dry) { console.log(`+ [${new Date(g.latest).toISOString().slice(0, 10)}] ${theme.padEnd(20)} ${g.commits.length}c  ${title.slice(0, 64)}`); posted++; continue; }
  try {
    await fetch(`${url}/task`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, title, status: "done", phase: theme, source: "git", ts: g.latest, assignee: me, by: me }) });
    posted++;
  } catch (e) { console.error(`post failed for "${title}": ${e.message}`); }
}
console.log(`${dry ? "[dry-run] " : ""}backfill: ${posted} theme-card(s) from ${rows.length} commits / ${groups.size} themes (${skipped} already on board) → ${project}`);
