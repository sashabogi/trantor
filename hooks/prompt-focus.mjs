#!/usr/bin/env node
// trantor UserPromptSubmit hook — turn each substantive user prompt into the session's live "focus" card,
// so a REGULAR (non-crew) Claude session's OWN work shows IN PROGRESS on the board as it happens — not only
// when it commits or dispatches a sub-agent. ONE rolling card per session (the hub re-titles it as the focus
// shifts and closes it to "done" when the session goes offline). Trivial acks ("yes", "go ahead") don't
// refocus. Fail-silent + fast: NO LLM call (the title is a heuristic clean of the prompt; Scrooge-summarized
// titles are a follow-up). Never blocks or delays the turn.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject, hostId } from "../lib/project.mjs";

function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 100); });
}
function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try { const c = join(homedir(), ".agent-bus", "config.json"); if (existsSync(c)) { const u = JSON.parse(readFileSync(c, "utf8")).url; if (u) return u; } } catch {}
  return "http://127.0.0.1:4477";
}
// A prompt that is JUST an acknowledgement/continuation (anchored to end) — not a new focus.
const ACK = /^(y|yes|yep|yeah|ok|okay|sure|go|go ahead|continue|proceed|do it|please|thanks|thank you|ty|next|k|cool|nice|great|perfect|sounds good|👍)[\s.!]*$/i;
function titleFrom(prompt) {
  let s = String(prompt || "").replace(/\s+/g, " ").trim();
  // strip a leading politeness/imperative wrapper so the card reads as the WORK, not "can you please…"
  s = s.replace(/^(please|can you|could you|would you|hey,?|ok,?|now,?|let's|lets|i want you to|i'd like you to|i need you to|go ahead and)\s+/i, "");
  return s.slice(0, 120);
}

try {
  if (process.env.TRANTOR_NO_FOCUS === "1") { process.stdout.write("{}"); process.exit(0); }   // opt-out
  const input = JSON.parse((await readStdin()) || "{}");
  const prompt = String(input.prompt || "");
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // don't card home-dir sessions (matches sessionstart's phantom-project guard)
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && cwd === homedir()) { process.stdout.write("{}"); process.exit(0); }
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  // skip empties, tiny continuations, and pure acks — they're not a new focus
  if (!trimmed || trimmed.length < 12 || ACK.test(trimmed)) { process.stdout.write("{}"); process.exit(0); }
  const project = resolveProject(cwd);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);
  await fetch(`${relayUrl()}/focus`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, project, title: titleFrom(trimmed), by: session }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => {});
} catch (e) {
  process.stderr.write(`[trantor] prompt-focus error: ${e?.message || e}\n`);
}
process.stdout.write("{}");
process.exit(0);
