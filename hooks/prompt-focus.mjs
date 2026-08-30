#!/usr/bin/env node
// trantor UserPromptSubmit hook — turn each substantive user prompt into the session's live "focus" card,
// so a REGULAR (non-crew) Claude session's OWN work shows IN PROGRESS on the board as it happens — not only
// when it commits or dispatches a sub-agent. ONE rolling card per session (the hub re-titles it as the focus
// shifts and closes it to "done" when the session goes offline). Trivial acks ("yes", "go ahead") don't
// refocus. Fail-silent + fast: NO LLM call ON THE TURN PATH — the title is a heuristic clean of the
// prompt, posted immediately. A long prompt then hands its rewrite to bin/focus-title.mjs, spawned
// DETACHED so a cheap model can produce a readable board line a few seconds later without the user
// ever waiting on it. Never blocks or delays the turn.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveProject, hostId } from "../lib/project.mjs";
import { signedPost, relayUrl } from "./lib/api.mjs";

function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 100); });
}
// A prompt that is JUST an acknowledgement/continuation (anchored to end) — not a new focus.
const ACK = /^(y|yes|yep|yeah|ok|okay|sure|go|go ahead|continue|proceed|do it|please|thanks|thank you|ty|next|k|cool|nice|great|perfect|sounds good|👍)[\s.!]*$/i;
function titleFrom(prompt) {
  let s = String(prompt || "").replace(/\s+/g, " ").trim();
  // strip a leading politeness/imperative wrapper so the card reads as the WORK, not "can you please…"
  s = s.replace(/^(please|can you|could you|would you|hey,?|ok,?|now,?|let's|lets|i want you to|i'd like you to|i need you to|go ahead and)\s+/i, "");
  return s.slice(0, 120);
}


// §5 recap net (SYSTEM-CONTRACT): while this session carries a claimed-but-unrecapped handoff
// (the recap-pending stamp sessionstart wrote), EVERY prompt before its first Stop carries the
// reminder — including the stale queued message that ate the 2026-08-30 takeover. The stamp is
// cleared (and RECAPPED recorded) by stop-inbox at the first turn boundary.
import { handoffDir } from "../lib/project.mjs";
import { existsSync as _ex, readFileSync as _rf } from "node:fs";
let RECAP_CTX = "";
function loadRecapCtx(sessionId) {
  try {
    if (!sessionId) return "";
    const p = join(handoffDir(), `recap-pending-${String(sessionId).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    if (!_ex(p)) return "";
    const rec = JSON.parse(_rf(p, "utf8"));
    return `<system-reminder>You took over via handoff ${rec.handoffId}. If you have not yet recapped it, your reply MUST begin with the ≤3-sentence recap (task, state, next step) before anything else — including before answering this message.</system-reminder>`;
  } catch { return ""; }
}
function emitAndExit() {
  process.stdout.write(RECAP_CTX
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: RECAP_CTX } })
    : "{}");
  process.exit(0);
}

try {
  if (process.env.TRANTOR_NO_FOCUS === "1") { emitAndExit(); }   // opt-out
  const input = JSON.parse((await readStdin()) || "{}");
  RECAP_CTX = loadRecapCtx(String(input.session_id || ""));
  const prompt = String(input.prompt || "");
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // don't card home-dir sessions (matches sessionstart's phantom-project guard)
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && cwd === homedir()) { emitAndExit(); }
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  // skip empties, tiny continuations, and pure acks — they're not a new focus
  if (!trimmed || trimmed.length < 12 || ACK.test(trimmed)) { emitAndExit(); }
  // HARNESS-INJECTED prompts are not a human's focus. Task notifications, hook system-reminders and
  // protocol frames arrive through the same UserPromptSubmit channel, and carding one titled a board
  // card "<task-notification> <task-id>bavlqfmzq</task-id>…" — pure noise a human cannot read.
  if (/^\s*[<{[]/.test(trimmed) || /<task-notification>|<system-reminder>|<teammate-message/i.test(trimmed)) {
    emitAndExit();
  }
  const project = resolveProject(cwd);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);
  // The Claude Code session UUID. `session` above is a BUS id — per host+project — so without this
  // two Claude sessions in one project share (and fight over) a single focus card, and sub-agent
  // cards, whose `parent` is exactly this UUID, have nothing to nest under.
  const cc = String(input.session_id || "").slice(0, 120);
  const r = await signedPost("/focus", { session, project, title: titleFrom(trimmed), by: session, cc }, { session });

  // Only pay a model when the heuristic actually mangles the prompt. A short, already-clear ask
  // ("fix the login redirect") reads fine as-is and buying a rewrite for it is exactly the kind of
  // reflexive spend the economics doctrine exists to stop.
  const id = r?.json?.id;
  if (id && trimmed.length > 90 && process.env.TRANTOR_NO_SCROOGE_TITLES !== "1") {
    try {
      const busDir = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
      mkdirSync(busDir, { recursive: true });
      const pf = join(busDir, `focus-prompt-${String(cc || session).replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`);
      writeFileSync(pf, trimmed);
      const worker = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "focus-title.mjs");
      // Detached + unref'd + stdio ignored: the hook returns NOW. Nothing downstream waits on this,
      // and a worker that dies takes the heuristic title with it, which is a fine outcome.
      spawn(process.execPath, [worker, "--id", String(id), "--hub", relayUrl(project), "--prompt-file", pf, "--project", project],
        { detached: true, stdio: "ignore" }).unref();
    } catch {}
  }
} catch (e) {
  process.stderr.write(`[trantor] prompt-focus error: ${e?.message || e}\n`);
}
emitAndExit();
