#!/usr/bin/env node
// trantor UserPromptSubmit hook — each substantive prompt becomes the session's ONE rolling "focus"
// card, so a regular session's own work shows IN PROGRESS on the board. Trivial acks do not refocus.
// No LLM call on the turn path: a heuristic title posts immediately, and a long prompt hands its
// rewrite to bin/focus-title.mjs, spawned DETACHED. Never blocks or delays the turn.
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
// A paste arrives wrapped in `<pasted_content id="…">…</pasted_content>`: the wrapper is transport,
// not content — the operator typed what is inside (#10027's chat.rs rule, same channel). Peel it so
// the marker check and the focus title see the words, never the tag. Unwrapped text passes through.
function unwrapPasted(t) {
  const s = String(t || "").trim();
  if (!s.startsWith("<pasted_content")) return s;
  const gt = s.indexOf(">");
  if (gt < 0) return s;
  const close = s.lastIndexOf("</pasted_content>");
  return (close > gt ? s.slice(gt + 1, close) : s.slice(gt + 1)).trim();
}
// HARNESS-INJECTED prompts are not a human's focus. A CLOSED list of known prefixes, not "starts
// with <": a paste merely happens to start with a tag, and a human quoting JSON is still a human.
// (The old ^\s*[<{[] heuristic silently dropped every pasted operator prompt, #11110.)
const HARNESS_MARKERS = [
  "<task-notification", "<system-reminder", "<teammate-message",
  "<command-name", "<environment_context", "[SYSTEM NOTIFICATION",
];
const isHarnessInjection = (t) => HARNESS_MARKERS.some(m => t.startsWith(m));
function titleFrom(prompt) {
  let s = String(prompt || "").replace(/\s+/g, " ").trim();
  // strip a leading politeness/imperative wrapper so the card reads as the WORK, not "can you please…"
  s = s.replace(/^(please|can you|could you|would you|hey,?|ok,?|now,?|let's|lets|i want you to|i'd like you to|i need you to|go ahead and)\s+/i, "");
  return s.slice(0, 120);
}


// §5 recap net (SYSTEM-CONTRACT): while this session carries a claimed-but-unrecapped handoff, EVERY
// prompt before its first Stop carries the reminder; stop-inbox clears the stamp at the first boundary.
import { handoffDir } from "../lib/project.mjs";
import { existsSync as _ex, readFileSync as _rf } from "node:fs";
let RECAP_CTX = "";
function loadRecapCtx(sessionId) {
  try {
    if (!sessionId) return "";
    const p = join(handoffDir(), `recap-pending-${String(sessionId).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    if (!_ex(p)) return "";
    const rec = JSON.parse(_rf(p, "utf8"));
    // #5645 mandate pinning: the stamp carries rec.mode — the reminder enforces the SAME succession
    // mandate the sessionstart injection announced, right up to the first Stop that records RECAPPED.
    const mandate = rec.mode === "unattended"
      ? " Then RESUME the handoff's OPEN THREADS immediately — they are your work order; this succession is unattended, do NOT wait for the user."
      : " Then WAIT for the user.";
    return `<trantor-takeover>You took over via handoff ${rec.handoffId}. If you have not yet recapped it, your reply MUST begin with the ≤3-sentence recap (task, state, next step) before anything else — including before answering this message.${mandate}</trantor-takeover>`;
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
  const text = unwrapPasted(trimmed);   // a paste's wrapper is transport; judge the words inside
  // skip empties, tiny continuations, and pure acks — they're not a new focus
  if (!text || text.length < 12 || ACK.test(text)) { emitAndExit(); }
  // The Accounts ask drill launches a real Claude session, so its scripted prompt traverses this
  // hook just like operator work. It is harness traffic, though, and must never become a focus card.
  if (/\bTRANTOR ASK DRILL\b/.test(text)) { emitAndExit(); }
  // Task notifications, hook reminders and protocol frames arrive through the same UserPromptSubmit
  // channel, and carding one titled a board card "<task-notification> <task-id>bavlqfmzq</task-id>…"
  // — pure noise a human cannot read.
  if (isHarnessInjection(text)) { emitAndExit(); }
  const project = resolveProject(cwd);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);
  // The Claude Code session UUID. `session` above is a BUS id — per host+project — so without this
  // two Claude sessions in one project share (and fight over) a single focus card, and sub-agent
  // cards, whose `parent` is exactly this UUID, have nothing to nest under.
  const cc = String(input.session_id || "").slice(0, 120);
  const r = await signedPost("/focus", { session, project, title: titleFrom(text), by: session, cc }, { session });

  // Only pay a model when the heuristic actually mangles the prompt. A short, already-clear ask
  // ("fix the login redirect") reads fine as-is and buying a rewrite for it is exactly the kind of
  // reflexive spend the economics doctrine exists to stop.
  const id = r?.json?.id;
  if (id && text.length > 90 && process.env.TRANTOR_NO_SCROOGE_TITLES !== "1") {
    try {
      const busDir = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
      mkdirSync(busDir, { recursive: true });
      const pf = join(busDir, `focus-prompt-${String(cc || session).replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`);
      writeFileSync(pf, text);
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
