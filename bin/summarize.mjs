#!/usr/bin/env node
// trantor summarize — narrative cards: what was ASSIGNED and what was DONE, in plain language.
//
//   trantor summarize [--project <p>] [--limit N] [--all] [--dry] [--quiet]
//
// Title-cleaning makes machine-generated cards readable; it cannot make them MEAN anything. This
// gives each card a one-line narrative ("assigned — did") written by a CHEAP model from the card's
// own thread (its events + the messages that cite it). The board then reads as a story a human can
// follow, which was the ask: "what the agent was assigned, what the agent did, what the flow was."
//
// Economics by design (the Scrooge doctrine): candidates are MACHINE-TITLED cards without a
// summary (--all widens to every unsummarized card), batched into ONE cheap-model call per hub,
// difficulty easy, capped per run. The summary lands via /task/update and rides the tasks.extra
// column — permanent, never recomputed. Runs ambiently from the heartbeat (hourly, detached) and
// on demand as `trantor summarize`.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadOrCreate } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";

const argv = process.argv.slice(2);
const val = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? (argv[i + 1] ?? "") : ""; };
const has = (k) => argv.includes(`--${k}`);
const QUIET = has("quiet");
const say = (...a) => { if (!QUIET) console.log(...a); };

const BUS_DIR = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
let config = {}; try { config = JSON.parse(readFileSync(join(BUS_DIR, "config.json"), "utf8")); } catch {}
const LIMIT = Math.max(1, Number(val("limit")) || 25);
const PROJECT = val("project");
const OWNER = config.ownerIdentity || "admin";
const ownerId = loadOrCreate(OWNER, "human");

const scroogeBin = () => process.env.SCROOGE_BIN
  || (() => { try { return execSync("command -v scrooge", { encoding: "utf8" }).trim(); } catch {} })()
  || (existsSync(new URL("../engine/bin/scrooge", import.meta.url)) ? new URL("../engine/bin/scrooge", import.meta.url).pathname : "");

// A title no human wrote: protocol frames, dumped prompts, id soup. These are the cards whose
// board presence is noise until a narrative replaces them.
const machineTitled = (t) =>
  /^\s*[<{[]/.test(t) || /<task-notification>|<system-reminder>|toolu_[A-Za-z0-9]/.test(t) ||
  /^\s*(subagent|general-purpose|Explore|Task|Plan):/i.test(t) || t.length > 130;

const hubs = new Set([config.url || "http://127.0.0.1:4477", ...Object.values(config.hubs || {})]);
const get = async (hub, path) => (await sfetchJson(`${hub}${path}`, { method: "GET", identity: ownerId, signal: AbortSignal.timeout(8000) })).json();
const post = async (hub, path, payload) => {
  const r = await sfetchJson(`${hub}${path}`, { identity: ownerId, payload, signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (!r.ok || j?.error) throw new Error(`${path} → ${r.status} ${j?.error || ""}`);
  return j;
};

let wrote = 0, considered = 0;
for (const hub of hubs) {
  let cards = [];
  try { cards = (await get(hub, PROJECT ? `/tasks?project=${encodeURIComponent(PROJECT)}` : "/tasks")).tasks ?? []; }
  catch { continue; }
  const cand = cards
    .filter(t => !t.summary && (has("all") || machineTitled(String(t.title || ""))))
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    .slice(0, LIMIT);
  considered += cand.length;
  if (!cand.length) continue;
  say(`${hub}: ${cand.length} card(s) need a narrative`);

  // each card's own story: status + thread tail (the agent's reports of what it did)
  const blocks = [];
  for (const t of cand) {
    let thread = "";
    try {
      const c = await get(hub, `/card?id=${t.id}`);
      thread = (c.messages ?? []).slice(-5).map(m => `${m.from}: ${String(m.text).replace(/\s+/g, " ").slice(0, 220)}`).join("\n");
    } catch {}
    blocks.push(`CARD #${t.id} [${t.status}]${t.assignee ? ` assignee=${t.assignee}` : ""}\nTITLE: ${String(t.title).replace(/\s+/g, " ").slice(0, 400)}${thread ? `\nTHREAD:\n${thread}` : ""}`);
  }
  const prompt = `You write one-line narratives for cards on an AI-agent Kanban board. For EACH card below:
- "assigned": the task in plain language, action-first, <=70 chars (from TITLE; ignore XML/ids/protocol noise)
- "did": what actually happened per THREAD and status, <=80 chars; "" if nothing has happened yet
Plain words a human skims. No ids, no paths unless essential, no XML.
Return ONLY a JSON array: [{"id":<number>,"assigned":"...","did":"..."}]

${blocks.join("\n\n")}`;

  const bin = scroogeBin();
  if (!bin) { console.error("scrooge not found (set SCROOGE_BIN) — cannot summarize."); process.exit(1); }
  const res = spawnSync(bin, ["-t", "summarize", "-d", "easy", "--json"], { input: prompt, encoding: "utf8", timeout: 120000 });
  if (res.error || (res.status !== 0 && !res.stdout)) { console.error(`scrooge failed: ${(res.stderr || res.error?.message || "").slice(-200)}`); continue; }
  let rows = [];
  try { const out = res.stdout || ""; rows = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)); }
  catch { console.error(`unparseable summarizer output: ${(res.stdout || "").slice(0, 200)}`); continue; }

  const byId = new Map(cand.map(t => [t.id, t]));
  for (const r of rows) {
    const t = byId.get(Number(r.id));
    const assigned = String(r.assigned || "").trim();
    if (!t || !assigned) continue;
    const summary = (r.did ? `${assigned} — ${String(r.did).trim()}` : assigned).slice(0, 220);
    if (has("dry")) { say(`  #${t.id} would become: ${summary}`); continue; }
    try { await post(hub, "/task/update", { id: t.id, summary, by: "scrooge-summarizer" }); wrote++; say(`  #${t.id} → ${summary}`); }
    catch (e) { say(`  #${t.id} write failed: ${e.message}`); }
  }
}
say(`\n${has("dry") ? "[dry] " : ""}${wrote} narrative(s) written · ${considered} candidate(s) seen`);
