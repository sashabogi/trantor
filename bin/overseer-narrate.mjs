#!/usr/bin/env node
// trantor overseer-narrate — narrate overseer.warn events with plain-language action text.
//
//   trantor overseer-narrate [--limit N] [--dry] [--quiet]
//
// The overseer tick emits overseer.warn events as mechanical, computed facts (kind, sessions, files,
// detail). This worker gives each un-narrated warning a one-line action text ("coordinate over the
// bus / split files / declare a link") written by a CHEAP model, then POSTs it back to the hub.
// Economics by design: candidates are unnarrated overseer.warn events, batched into ONE cheap-model
// call per hub, difficulty easy. Runs ambiently from the heartbeat and on demand.
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
const LIMIT = Math.max(1, Number(val("limit")) || 100);
const OWNER = config.ownerIdentity || "admin";
const ownerId = loadOrCreate(OWNER, "human");

const scroogeBin = () => process.env.SCROOGE_BIN
  || (() => { try { return execSync("command -v scrooge", { encoding: "utf8" }).trim(); } catch {} })()
  || (existsSync(new URL("../engine/bin/scrooge", import.meta.url)) ? new URL("../engine/bin/scrooge", import.meta.url).pathname : "");

const hubs = new Set([config.url || "http://127.0.0.1:4477", ...Object.values(config.hubs || {})]);
const get = async (hub, path) => (await sfetchJson(`${hub}${path}`, { method: "GET", identity: ownerId, signal: AbortSignal.timeout(8000) })).json();

let narrated = 0, considered = 0;
for (const hub of hubs) {
  let events = [];
  try { events = (await get(hub, `/events?type=overseer.&limit=${LIMIT}`)).events ?? []; }
  catch { continue; }
  const unnarrated = events.filter(e => !e.narrated && e.detail);
  considered += unnarrated.length;
  if (!unnarrated.length) continue;
  say(`${hub}: ${unnarrated.length} overseer warning(s) need narration`);

  const blocks = unnarrated.map(e =>
    `EVENT #${e.id} [${e.project}]\nKIND: ${e.kind}\nSESSIONS: ${(e.sessions || []).join(", ")}\nFILES: ${(e.files || []).join(", ")}\nDETAIL: ${e.detail}`
  );

  const prompt = `You write one-line action narratives for AI-agent collision warnings. For EACH event below, write what the sessions should do — coordinate over the bus, split files, declare a link. <=200 chars. Cite sessions/files/projects from the detail. Return ONLY a JSON array: [{"eventId":<number>,"text":"..."}]

${blocks.join("\n\n")}`;

  const bin = scroogeBin();
  if (!bin) { console.error("scrooge not found (set SCROOGE_BIN) — cannot narrate."); process.exit(1); }
  const res = spawnSync(bin, ["-t", "reason", "-d", "easy", "--json"], { input: prompt, encoding: "utf8", timeout: 120000 });
  if (res.error || (res.status !== 0 && !res.stdout)) { console.error(`scrooge failed: ${(res.stderr || res.error?.message || "").slice(-200)}`); continue; }
  let rows = [];
  try { const out = res.stdout || ""; rows = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)); }
  catch { console.error(`unparseable narrator output: ${(res.stdout || "").slice(0, 200)}`); continue; }

  const byId = new Map(unnarrated.map(e => [e.id, e]));
  for (const r of rows) {
    const e = byId.get(Number(r.eventId));
    const text = String(r.text || "").trim().slice(0, 200);
    if (!e || !text) continue;
    if (has("dry")) { say(`  event #${e.id} would become: ${text}`); continue; }
    try {
      const res = await sfetchJson(`${hub}/overseer/narrate`, { identity: ownerId, payload: { eventId: e.id, text }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) { say(`  event #${e.id} POST failed: ${res.status}`); continue; }
      narrated++;
      say(`  event #${e.id} → ${text}`);
    } catch (e2) { say(`  event #${e.id} write failed: ${e2.message}`); }
  }
}
say(`\n${has("dry") ? "[dry] " : ""}${narrated} narration(s) written · ${considered} event(s) considered`);
