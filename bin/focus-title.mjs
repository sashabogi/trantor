#!/usr/bin/env node
// trantor focus-title — give a session's focus card a title a human can skim, written by a CHEAP model.
//
//   node bin/focus-title.mjs --id <cardId> --hub <url> --prompt-file <path> [--project <p>]
//
// The focus card is titled from the user's raw prompt by a regex in hooks/prompt-focus.mjs. That is
// the right thing to do IN the turn — a hook that waits on an LLM delays every prompt the user
// types — but a raw prompt makes a poor board card: it is long, it is addressed to Claude rather
// than describing work, and half of it is context the board does not need. So the hook posts the
// heuristic title instantly and hands the rewrite to this, DETACHED: the card is on the board in
// milliseconds and gets its readable line a few seconds later.
//
// Economics (the Scrooge doctrine): one `-t summarize -d easy` call, only for prompts the heuristic
// actually mangles — the hook does not even spawn this for a short, already-clear prompt. The
// result lands in `summary`, the same field the board already prefers over `title`, and the hub
// clears it on every refocus so a stale line can never shadow live work.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadOrCreate } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";

const argv = process.argv.slice(2);
const val = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? (argv[i + 1] ?? "") : ""; };
const ID = Number(val("id"));
const HUB = val("hub");
const PROMPT_FILE = val("prompt-file");
if (!ID || !HUB || !PROMPT_FILE) process.exit(0);          // nothing to do; never a visible failure

const scroogeBin = () => process.env.SCROOGE_BIN
  || (() => { try { return execSync("command -v scrooge", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } })()
  || (existsSync(new URL("../engine/bin/scrooge", import.meta.url)) ? new URL("../engine/bin/scrooge", import.meta.url).pathname : "");

try {
  const raw = readFileSync(PROMPT_FILE, "utf8").replace(/\s+/g, " ").trim();
  if (!raw) process.exit(0);
  const bin = scroogeBin();
  if (!bin) process.exit(0);                               // no economics engine installed — heuristic title stands

  const ask = `Rewrite this message to an AI coding assistant as a Kanban card title: what the WORK is, action first, in plain words a human skims. At most 70 characters. No quotes, no trailing period, no "the user wants". If it is several requests, name the main one. Return ONLY the title.

${raw.slice(0, 1800)}`;
  const res = spawnSync(bin, ["-t", "summarize", "-d", "easy"], { input: ask, encoding: "utf8", timeout: 60000 });
  if (res.error || !res.stdout) process.exit(0);
  // A cheap model sometimes wraps or explains. Take the first non-empty line and strip the wrapper.
  const line = String(res.stdout).split("\n").map(l => l.trim()).find(l => l && !/^```/.test(l)) || "";
  const title = line.replace(/^["'`]+|["'`.]+$/g, "").replace(/^(title|card)\s*:\s*/i, "").trim().slice(0, 70);
  // Guard against the failure modes that would make the board WORSE than the heuristic: an empty
  // answer, a refusal, or the model echoing the prompt back at us.
  if (title.length < 8 || /^(sorry|i can|as an ai)/i.test(title) || title.toLowerCase() === raw.toLowerCase().slice(0, title.length)) process.exit(0);

  const owner = (() => { try { return JSON.parse(readFileSync(join(process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"), "config.json"), "utf8")).ownerIdentity; } catch { return ""; } })();
  const identity = loadOrCreate(owner || "admin", "human");
  await sfetchJson(`${HUB}/task/update`, { identity, payload: { id: ID, summary: title, by: "scrooge-focus-title" }, signal: AbortSignal.timeout(8000) });
} catch { /* a board title is never worth surfacing an error for */ }
process.exit(0);
