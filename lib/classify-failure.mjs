// Failure classification for crew seats (#5868), lifted out of crew-runner.mjs so the rules are
// unit-testable against the real specimens that misfired; the rules are in docs/CONTRACT-lib.md.
import { readFileSync } from "node:fs";

export const AUTH_MARKER_RE = /unauthor|401|403|forbidden|invalid[ _-]?api[ _-]?key|authentication? failed|token expired/i;

/** Prompt lines (≥40 chars) echoed back by the CLI are replay, not speech (#6049). Both sides are
 *  normalized (ANSI, whitespace) and a line drops when it contains, is, or shares a ≥40-char run with one. */
const ECHO_RUN = 40;
export function stripPromptEcho(errText, promptText) {
  const text = String(errText || "");
  if (!promptText) return text;
  const norm = (l) => String(l).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
  const promptLines = String(promptText).split("\n").map(norm).filter(Boolean);
  if (!promptLines.length) return text;
  const prompts = promptLines.filter(l => l.length >= 40);
  // Whole-prompt normalized text for the short-line VERBATIM check: a short echoed wake fragment has
  // no 40-char run but still reappears byte-for-byte, and must not trip looksLikeAuthDeath (#6110).
  const promptFull = promptLines.join(" ");
  const hasRun = (p, n) => {
    for (let i = 0; i + ECHO_RUN <= p.length; i++) if (n.includes(p.slice(i, i + ECHO_RUN))) return true;
    return false;
  };
  return text.split("\n").filter(line => {
    const n = norm(line);
    if (!n) return true;
    // Short lines: survive unless they are a multi-word fragment (has a space — excludes a bare
    // token like "codex" or "4,387" that trivially co-occurs with unrelated prompt text) that
    // appears verbatim in the prompt. A genuine short CLI error the prompt never mentioned, or a
    // single echoed token, still passes through untouched; a full echoed phrase does not.
    if (n.length < 40) return !(n.includes(" ") && promptFull.includes(n));
    return !prompts.some(p => n.includes(p) || p.includes(n) || hasRun(p, n));
  }).join("\n");
}

/** A real answer is long; an auth death is a couple of lines. The opencode specimen (#5405)
 *  printed its whole failure in under a hundred characters and produced nothing else. */
export const OWN_OUTPUT_ANSWER_MIN = 400;

/** #7752/#7099: what a CUT turn's exit says about WHY the CLI died. 141 is 128+13 — SIGPIPE: the
 *  time box's sweep ends a CLI still holding the turn's pipes, so the pipe death is the box's
 *  signature. 137 is 128+9 — SIGKILL: the sweep's own `kill -KILL` landing on the CLI. Either is
 *  recorded in the ledger row as the cut signal. Any other exit is not a signal. */
export function cutSignalFor(exit) {
  const n = Number(exit);
  return n === 141 ? "SIGPIPE" : n === 137 ? "SIGKILL" : "";
}

/** #7752: the verdict line for a SILENT cut — a turn that put bytes on neither stream and
 *  advanced no transcript for the whole watchdog window, ended by the runner at the window
 *  instead of the box. Named here so the drill pins the exact string the ledger carries. */
export function stallVerdict() {
  return "classified stalled because no bytes on either stream and no transcript advance for the whole watchdog window";
}

// ---- the hollow turn (#7759): exit 0, no worktree change, no substantive output ---------------
// A CLI banner is bytes on a stream, not work. ANSI stripped, a line is CHROME when it is a pure
// separator, decorative box/block art, or a label a CLI prints about itself (session, model,
// provider, workdir, version, tokens) — metadata about the run, never the run's answer.
const BANNER_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]/;
const SEPARATOR_RE = /^[-=*_~.#]{3,}$/;
const CHROME_LABEL_RE = /^(?:session|model|provider|workdir|directory|version|tokens|thinking|truncating|truncated|hint|tip|ctrl|openai|opencode|codex|claude|gemini|kimi|deepseek|glm|qwen|dsh)\b/i;
export const SUBSTANTIVE_MIN = 120;

/** Whether the CLI's echo-stripped output carries anything beyond banner and hook noise: the
 *  surviving signal lines must total at least SUBSTANTIVE_MIN chars — a sentence or two. A real
 *  answer clears this easily; a banner contributes nothing once its chrome is dropped (#7759). */
export function substantiveOutput(ownText) {
  const lines = String(ownText || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n").map(l => l.trim()).filter(Boolean);
  const signal = lines.filter(l => !BANNER_RE.test(l) && !SEPARATOR_RE.test(l) && !CHROME_LABEL_RE.test(l));
  return signal.join("\n").length >= SUBSTANTIVE_MIN;
}

/** The #5405 rule, refined twice by #5868: exit 0 + an auth-shaped marker means FAILED only when
 *  the CLI's own output is short enough to be JUST the error — and NEVER when the turn did real
 *  work (newCommit, checked by the runner via git): a shipped commit is a live turn, whatever the
 *  captured stream happens to hold. */
export function looksLikeAuthDeath(ownText, realWork = false) {
  if (realWork) return false;
  return String(ownText || "").length < OWN_OUTPUT_ANSWER_MIN && AUTH_MARKER_RE.test(ownText);
}

/** The one-line verdict the seat's jsonl carries (#5868): why the runner judged the turn the way
 *  it did, phrased exactly like the runner's own "classified X because Y" log — so a pane that
 *  scrolls away loses nothing that the telemetry row needs to say. */
export function verdictFor(realExit, effExit, emptyOutput, ownText, emptyTurn = false, cut = false) {
  if (realExit === 0 && effExit === 0) return emptyTurn
    ? "classified empty-turn because exit 0 with no worktree change, no substantive output, no bus activity"
    : "classified success because exit 0 with CLI output";
  if (realExit === 0 && effExit === 1) {
    if (emptyOutput) return "classified empty-output because exit 0 with no output on either stream";
    const m = AUTH_MARKER_RE.exec(String(ownText || ""));
    return `classified auth because ${m ? m[0] : "auth marker"} in the CLI's own short output`;
  }
  const { reason, matched } = classifyFailure(realExit, String(ownText || ""), emptyOutput, emptyTurn, cut);
  return `classified ${reason} because ${matched}`;
}

/** Classify one failed turn. Returns { reason, matched } — matched is the evidence excerpt the
 *  runner logs, so the next misclassification is diagnosable from the seat log alone. `cut` is the
 *  runner's box/stall marker: 137 reads as the sweep's SIGKILL only under it — without the marker
 *  the same exit is an OOM or an outside kill and stays a crash (#7099). */
export function classifyFailure(exit, errText, emptyOutput = false, emptyTurn = false, cut = false) {
  // #5481: silence with a clean exit is a failure shape, not success — see lastEmptyOutput.
  if (emptyOutput) return { reason: "empty-output", matched: "exit 0 with no output on either stream" };
  const t = String(errText || "").toLowerCase();
  if (exit === 127) return { reason: "missing-cli", matched: "exit 127 — command not found" };
  // #7099/#7752: 141 is the box's own signature (SIGPIPE — the sweep ended a CLI still holding
  // the turn's pipes), recorded as the cut signal. The provider's answer never landed, so no
  // quota or crash pattern may match it: a captured "rate-limit" line once parked a silent
  // qwen seat as exhausted on a turn the box itself had killed.
  if (Number(exit) === 141) return { reason: "cut-signal", matched: "exit 141 — SIGPIPE from the time box sweep, not a provider failure" };
  // #7099: 137 is the sweep's `kill -KILL` (#7099's claude specimen: four turns died at exactly
  // TURN_MAX_MS with exit 137, each retried as "crashed"). Only the runner's cut marker proves the
  // box did it, so this rule ranks BELOW the unconditional 141 but REQUIRES `cut`: a bare 137 is
  // an OOM or an outside kill and falls through to the ordinary patterns.
  if (cut && Number(exit) === 137) return { reason: "cut-signal", matched: "exit 137 — SIGKILL from the time box sweep, not a provider failure" };
  // #5684: a provider BACKEND failure is not quota — it wants retry/swap, not a window wait.
  // The specimen (#5683): codex's "unexpected status 404 Not Found … /responses/compact" was
  // labelled "exhausted" and the operator was advised to wait out a window that did not exist.
  // 401/403/429 deliberately fall through to the auth/exhausted branches below.
  let m = t.match(/unexpected status (?:404|408|410|5\d\d)|internal server error|bad gateway|service unavailable|gateway time.?out|econnrefused|connection refused|socket hang ?up|network is unreachable/);
  if (m) return { reason: "backend-error", matched: m[0] };
  // "reached your … limit" / "usage limit" catch the subscription CLIs (Claude's "You've reached
  // your Fable 5 limit"), which say nothing about quota or credits and would otherwise read as a crash.
  m = t.match(/quota|payment required|402|429|too many requests|rate.?limit|usage limit|exceeded your|reached your [^.\n]*limit|insufficient (?:credits?|funds)|out of (?:credits?|quota)/);
  if (m) return { reason: "exhausted", matched: m[0] };
  m = t.match(/unauthor|401|invalid[ _-]?api[ _-]?key|forbidden|403|token expired|expired/);
  if (m) return { reason: "auth", matched: m[0] };
  // #7759: exit 0 with bytes on the stream but neither a changed worktree nor substantive output
  // is a HOLLOW turn — the CLI printed its banner and quit. It ranks BELOW every real failure
  // shape above: an auth-shaped or exhausted exit is that failure, never an empty turn.
  if (emptyTurn) return { reason: "empty-turn", matched: "exit 0 with no worktree change, no substantive output, no bus activity" };
  return { reason: "crashed", matched: `exit ${exit} with no known failure pattern` };
}

/** Read the prompt file if it exists (the turn prompt the CLI may echo into its transcript). */
export function readPromptText(pf) {
  try { return readFileSync(pf, "utf8"); } catch { return ""; }
}
