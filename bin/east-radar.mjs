#!/usr/bin/env node
// East Radar — the deterministic half of the East/West delta scanner (the fuzzy half is the
// /trantor:east-radar skill). Keeps a "known" baseline so each run reports only what's NEW and
// material, writes the dated digest, and surfaces it as a Trantor board card.
//
//   trantor east-radar state                       # print the known baseline (what's already surfaced)
//   trantor east-radar record candidates.json      # diff vs baseline → write digest + update state
//   trantor east-radar card  radar/digests/<d>.md  # post a board card linking a digest (needs a hub)
//   trantor east-radar sync                         # card any digests not yet on the board
//
// State lives in $EAST_RADAR_DIR (default ~/.agent-bus/east-radar): state.json + digests/<date>.md.
// For the cloud-cron flow, point EAST_RADAR_DIR at a checked-out repo path and `git commit` it —
// that's how an ephemeral cloud run remembers, and how a later LOCAL session picks it up to card.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DIR = process.env.EAST_RADAR_DIR || join(homedir(), ".agent-bus", "east-radar");
const STATE = join(DIR, "state.json");
const DIGESTS = join(DIR, "digests");
const PROJECT = process.env.EAST_RADAR_PROJECT || "east-radar";
const SCOPES = ["models", "tooling", "social", "policy"];
const SCOPE_LABEL = { models: "Frontier models & research", tooling: "Dev tooling & open source", social: "Social & product discourse", policy: "Policy & industry" };

function hubUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { return JSON.parse(readFileSync(join(homedir(), ".agent-bus", "config.json"), "utf8")).url || "http://127.0.0.1:4477"; } catch { return "http://127.0.0.1:4477"; }
}
function today() { try { return execSync("date +%F", { encoding: "utf8" }).trim(); } catch { return "0000-00-00"; } }
export function loadState() { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return { updated: "", seen: {}, carded: [] }; } }
const slug = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

// --- pure core (unit-tested) -------------------------------------------------
// Filter candidates to those that are NEW (key unseen) and MATERIAL (significance ≥ threshold),
// and compute the next baseline. Seen keys are dropped silently — that IS the "are we missing this"
// gate. Returns { fresh, next, droppedSeen, droppedWeak }.
export function computeDelta(candidates, state, threshold = 6) {
  const seen = (state && state.seen) || {};
  const fresh = [], next = { updated: state?.updated || "", seen: { ...seen }, carded: [...(state?.carded || [])] };
  let droppedSeen = 0, droppedWeak = 0;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const key = slug(c.key || c.title);
    if (!key) continue;
    const scope = SCOPES.includes(c.scope) ? c.scope : "models";
    if (next.seen[key]) { droppedSeen++; continue; }                 // already surfaced → not new
    if (Number(c.significance ?? 0) < threshold) { droppedWeak++; continue; }
    const item = { key, scope, title: String(c.title || key), significance: Number(c.significance) || 0,
      url: c.url || "", what: c.what || "", why: c.why || "", west: c.west || "" };
    fresh.push(item);
    next.seen[key] = { title: item.title, scope, firstSeen: "", url: item.url };  // firstSeen stamped by caller
  }
  // highest-significance first within the run
  fresh.sort((a, b) => b.significance - a.significance);
  return { fresh, next, droppedSeen, droppedWeak };
}

export function renderDigest(date, fresh) {
  const lines = [`# East Radar — ${date}`, "",
    `> _Editor's note: replace this line — the single most important thing we were missing this run, and the one thing worth acting on._`, ""];
  for (const scope of SCOPES) {
    const items = fresh.filter(i => i.scope === scope);
    if (!items.length) continue;
    lines.push(`## ${SCOPE_LABEL[scope]}`, "");
    for (const i of items) {
      lines.push(`### ${i.title}  ·  ${i.significance}/10`);
      if (i.what) lines.push(i.what);
      if (i.why) lines.push(`**Why it matters:** ${i.why}`);
      if (i.west) lines.push(`**West contrast:** ${i.west}`);
      if (i.url) lines.push(`[source](${i.url})`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// --- commands ----------------------------------------------------------------
function cmdState() {
  const s = loadState();
  const seen = s.seen || {};
  const byScope = {}; for (const v of Object.values(seen)) byScope[v.scope] = (byScope[v.scope] || 0) + 1;
  console.log(`East Radar baseline — ${Object.keys(seen).length} item(s) surfaced${s.updated ? `, last updated ${s.updated}` : ""}`);
  for (const sc of SCOPES) console.log(`  ${sc.padEnd(8)} ${byScope[sc] || 0}`);
  const recent = Object.entries(seen).slice(-12);
  if (recent.length) { console.log("recent keys:"); for (const [k, v] of recent) console.log(`  · ${k} (${v.scope})`); }
}

function cmdRecord(file, threshold) {
  if (!file || !existsSync(file)) { console.error("record: candidates JSON not found:", file); process.exit(1); }
  let candidates; try { candidates = JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.error("record: bad JSON —", e.message); process.exit(1); }
  const state = loadState();
  const date = today();
  const { fresh, next, droppedSeen, droppedWeak } = computeDelta(candidates, state, threshold);
  if (!fresh.length) { console.log(`east-radar: 0 new items (${droppedSeen} already known, ${droppedWeak} below threshold) — quiet run, nothing written.`); return; }
  for (const i of fresh) next.seen[i.key].firstSeen = date;          // stamp first-seen now
  next.updated = date;
  mkdirSync(DIGESTS, { recursive: true });
  const digestPath = join(DIGESTS, `${date}.md`);
  writeFileSync(digestPath, renderDigest(date, fresh) + "\n");
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(next, null, 2) + "\n");
  console.log(`east-radar: ${fresh.length} new item(s) → ${digestPath}`);
  console.log(`  (${droppedSeen} already known, ${droppedWeak} below threshold ${threshold})`);
  console.log(`  next: add your editor's note at the top, then  trantor east-radar card ${digestPath}`);
}

async function postCard(title, ts) {
  const url = hubUrl();
  try {
    const existing = (await (await fetch(`${url}/tasks?project=${encodeURIComponent(PROJECT)}`, { signal: AbortSignal.timeout(2500) })).json()).tasks || [];
    if (existing.some(t => t.title === title)) return "exists";
    await fetch(`${url}/task`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: PROJECT, title, status: "done", phase: "east-radar", source: "east-radar", ts, by: "east-radar" }),
      signal: AbortSignal.timeout(2500) });
    return "posted";
  } catch { return "no-hub"; }
}

async function cmdCard(digestPath) {
  if (!digestPath || !existsSync(digestPath)) { console.error("card: digest not found:", digestPath); process.exit(1); }
  const date = basename(digestPath).replace(/\.md$/, "");
  const body = readFileSync(digestPath, "utf8");
  const note = (body.match(/^> _?(?:Editor's note:\s*)?(.+?)_?\s*$/m) || [])[1] || "";
  const count = (body.match(/^### /gm) || []).length;
  const title = `East Radar — ${date}: ${count} new${note && !/replace this line/i.test(note) ? ` — ${note.slice(0, 120)}` : ""}`.slice(0, 190);
  const r = await postCard(title, Date.parse(date) || undefined);
  console.log(r === "posted" ? `carded: ${title}` : r === "exists" ? "card already on board (idempotent)" : "no hub reachable — digest written; a local `trantor east-radar sync` will card it later");
  if (r === "posted") { const s = loadState(); s.carded = [...new Set([...(s.carded || []), basename(digestPath)])]; writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n"); }
}

async function cmdSync() {
  if (!existsSync(DIGESTS)) { console.log("east-radar sync: no digests yet."); return; }
  const s = loadState(); const carded = new Set(s.carded || []);
  const pending = readdirSync(DIGESTS).filter(f => f.endsWith(".md") && !carded.has(f));
  if (!pending.length) { console.log("east-radar sync: all digests already carded."); return; }
  for (const f of pending) await cmdCard(join(DIGESTS, f));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, ...rest] = process.argv;
  const thIdx = rest.indexOf("--threshold");
  const threshold = thIdx >= 0 ? Number(rest[thIdx + 1]) || 6 : 6;
  const arg = rest.find(a => !a.startsWith("--") && a !== String(threshold));
  if (cmd === "state") cmdState();
  else if (cmd === "record") cmdRecord(arg, threshold);
  else if (cmd === "card") await cmdCard(arg);
  else if (cmd === "sync") await cmdSync();
  else { console.error("usage: trantor east-radar state | record <candidates.json> [--threshold N] | card <digest.md> | sync"); process.exit(1); }
}
