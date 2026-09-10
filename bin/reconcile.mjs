#!/usr/bin/env node
// trantor reconcile — INTELLIGENT board cleanup. The mechanical reaper only knows "owner offline → stale".
// reconcile reads the STUCK cards + recent git commits + project memory and, for each, asks a CHEAP model
// (Scrooge) whether it is DONE (already implemented/merged → close it so no future session re-does the work),
// truly STALE (abandoned), or still ACTIVE (leave it). The judgment is grunt classification → routed to a
// cheap model, never frontier tokens. Preview-first; changes nothing until --yes.
//   trantor reconcile                 # preview verdicts for this project's stuck cards
//   trantor reconcile --yes           # apply: DONE→done, abandoned→stale, ACTIVE left alone
//   trantor reconcile --older 6h      # only cards untouched this long are candidates (default 2h)
//   trantor reconcile --difficulty hard   # spend a stronger model on the judgment (default medium)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { resolveProject } from "../lib/project.mjs";

// Signed via the shared client (2026-07-31, agent-UX audit): the unsigned POST /task/update was
// rejected outright under enforce and merely flagged under warn; the hand-rolled relayUrl missed
// the per-project hubs map. signedGet/signedPost resolve the cwd project's hub + sign per call.
import { relayUrl, signedGet, signedPost } from "../hooks/lib/api.mjs";
function parseDur(s, def) {
  if (!s) return def;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return def;
  return Math.round(Number(m[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[(m[2] || "h").toLowerCase()]));
}
const fmtAge = ms => { const m = Math.round(ms / 60000); return m >= 1440 ? `${Math.floor(m / 1440)}d` : m >= 60 ? `${Math.floor(m / 60)}h` : `${m}m`; };
const scroogeBin = () => process.env.SCROOGE_BIN
  || (() => { try { return execSync("command -v scrooge", { encoding: "utf8" }).trim(); } catch {} })()
  || (existsSync(new URL("../engine/bin/scrooge", import.meta.url)) ? new URL("../engine/bin/scrooge", import.meta.url).pathname : "");

const argv = process.argv.slice(2);
const has = (...f) => f.some(x => argv.includes(x));
const val = (...f) => { for (const x of f) { const i = argv.indexOf(x); if (i >= 0) return argv[i + 1]; } return undefined; };
const olderMs = parseDur(val("--older", "-o"), 2 * 3600 * 1000);
const doIt = has("--yes", "-y");
const difficulty = ["easy", "medium", "hard"].includes(val("--difficulty", "-d")) ? val("--difficulty", "-d") : "medium";
const dir = process.cwd();
const project = resolveProject(dir);
const url = relayUrl(project);

async function tasks() {
  const r = await signedGet(`/tasks?project=${encodeURIComponent(project)}`, { timeoutMs: 6000 });
  if (!r.ok) return [];
  const j = r.json;
  return Array.isArray(j) ? j : (j?.tasks || j?.cards || []);
}
async function move(id, status, note) {
  return signedPost("/task/update", { id, status, by: "reconcile", note }, { timeoutMs: 4000 })
    .catch(e => ({ ok: false, status: 0, json: { error: e.message } }));
}
// #6452: the hub refuses done on a card with no drill line, and reconcile cannot claim a drill it
// never ran. A card judged shipped closes when it already carries a drill line; otherwise it parks
// at testing with the verdict on its log, and the orchestrator runs the drill and closes it.
async function close(x) {
  const note = `reconcile: judged shipped${x.commit ? ` at ${x.commit}` : ""}${x.reason ? ` — ${x.reason}` : ""}`;
  const r = await move(x.t.id, "done", note);
  if (r.ok) return "closed";
  if (r.status === 409 && /drill/i.test(r.json?.error || "")) {
    const parked = await move(x.t.id, "testing", `${note}; no drill line on the card, so it waits at testing for the orchestrator's drill`);
    if (parked.ok) return "parked";
    console.error(`    #${x.t.id}: hub ${parked.status} ${parked.json?.error || ""}`);
    return "failed";
  }
  console.error(`    #${x.t.id}: hub ${r.status} ${r.json?.error || ""}`);
  return "failed";
}
// the memory record for THIS project (Claude Code stores it per encoded-cwd); optional context.
function memoryExcerpt() {
  try {
    const p = join(homedir(), ".claude", "projects", dir.replaceAll("/", "-"), "memory", "MEMORY.md");
    if (existsSync(p)) return readFileSync(p, "utf8").slice(0, 6000);
  } catch {}
  return "";
}

console.log(`\n🧠 trantor reconcile — "${project}" · stuck > ${fmtAge(olderMs)} · judge=scrooge/${difficulty}\n${"─".repeat(60)}`);

// candidates: real work cards (not ephemeral sub-agent infra, not the session focus card) that are stuck.
const cut = Date.now() - olderMs;
const all = await tasks().catch(e => { console.error(`could not reach hub at ${url}: ${e.message}`); process.exit(1); });
const cand = all.filter(t =>
  ["todo", "doing", "testing", "stale"].includes(t.status) &&
  !["cc-subagent", "cc-bg-agent", "session"].includes(t.source) &&
  (t.updated || t.ts || 0) < cut);

if (!cand.length) { console.log("  nothing stuck to reconcile — the board is current.\n"); process.exit(0); }

const bin = scroogeBin();
if (!bin) { console.error("  scrooge not found (install it or set SCROOGE_BIN) — can't judge. Leaving the board untouched.\n"); process.exit(1); }

let gitlog = "";
try { gitlog = execSync(`git -C ${JSON.stringify(dir)} log --oneline -80 2>/dev/null`, { encoding: "utf8", timeout: 3000 }).trim(); } catch {}
const mem = memoryExcerpt();

const cardLines = cand.map(t => `#${t.id} [${t.status}] ${String(t.title).replace(/\s+/g, " ").slice(0, 110)}  (updated ${fmtAge(Date.now() - (t.updated || t.ts || 0))} ago)`).join("\n");
const prompt = `You reconcile a Kanban board against reality. For EACH card, decide if the work is:
- "done": clearly completed/merged — a recent commit or the memory shows it shipped;
- "stale": genuinely abandoned — queued/in-progress but no evidence of completion AND clearly old/superseded;
- "active": still legitimately pending or in progress — LEAVE IT.
Be CONSERVATIVE: mark "done" ONLY with real evidence (name the matching commit sha), and when unsure use "active".
Return ONLY a JSON array, no prose: [{"id":<number>,"verdict":"done"|"stale"|"active","reason":"<=90 chars","commit":"<sha or empty>"}]

RECENT COMMITS (newest first):
${gitlog || "(none)"}

${mem ? `PROJECT MEMORY (durable record):\n${mem}\n` : ""}
CARDS TO JUDGE:
${cardLines}`;

process.stdout.write("  judging with a cheap model… ");
const res = spawnSync(bin, ["-t", "reason", "-d", difficulty, "--json"], { input: prompt, encoding: "utf8", timeout: 90000 });
if (res.error || (res.status !== 0 && !res.stdout)) { console.error(`\n  scrooge unavailable/failed (${res.error ? res.error.code : (res.stderr || "").slice(-200)}) — leaving the board untouched.\n`); process.exit(1); }
let verdicts = [];
try {
  const out = res.stdout || "";
  const s = out.indexOf("["), e = out.lastIndexOf("]");
  verdicts = JSON.parse(out.slice(s, e + 1));
} catch (e) { console.error(`\n  couldn't parse the judge's output — leaving the board untouched.\n  raw: ${(res.stdout || "").slice(0, 300)}\n`); process.exit(1); }
console.log("done.\n");

const byId = new Map(cand.map(t => [t.id, t]));
const done = [], stale = [], active = [];
for (const v of verdicts) {
  const t = byId.get(Number(v.id)); if (!t) continue;
  (v.verdict === "done" ? done : v.verdict === "stale" ? stale : active).push({ ...v, t });
}
const show = (label, arr) => { if (!arr.length) return; console.log(`  ${label} (${arr.length}):`); for (const x of arr) console.log(`    #${x.t.id} [${x.t.status}] ${String(x.t.title).slice(0, 62)}\n        → ${x.verdict}${x.commit ? ` (${x.commit})` : ""}: ${x.reason || ""}`); };
show("✓ DONE — already shipped, will close", done);
show("🗑  STALE — abandoned, will move to Stale", stale);
show("• ACTIVE — still relevant, leaving alone", active);

if (!done.length && !stale.length) { console.log("\n  nothing to change — all stuck cards judged still-active.\n"); process.exit(0); }
if (!doIt) {
  console.log(`\n  ${done.length} card(s) → done, ${stale.length} → stale. Re-run to apply:\n    trantor reconcile${val("--older", "-o") ? ` --older ${val("--older", "-o")}` : ""} --yes\n`);
  process.exit(0);
}
const outcome = { closed: 0, parked: 0, failed: 0 };
for (const x of done) outcome[await close(x)]++;
for (const x of stale) await move(x.t.id, "stale");
console.log(`\n  ✓ reconciled: ${outcome.closed} closed as done${outcome.parked ? `, ${outcome.parked} parked at testing (no drill line)` : ""}${outcome.failed ? `, ${outcome.failed} refused` : ""}, ${stale.length} moved to stale. ${active.length} left active.\n`);
