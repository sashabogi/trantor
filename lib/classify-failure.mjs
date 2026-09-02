// Failure classification for crew seats (#5868) — split out of crew-runner.mjs so the rules are
// unit-testable against the REAL specimens that misfired.
//
// EVIDENCE (err-codex-trantor.txt + logs/codex-trantor.jsonl, 2026-09-02): the codex seat sat
// "DOWN — 44 consecutive failures (exhausted)" while every telemetry row read exit:0 and the
// transcript showed real work ("tokens used 4,387", Stop hooks, a delivered answer). Both labels
// were echoes of the seat's own PROMPT: the rules line "…deleting failing tests is forbidden."
// matched AUTH_MARKER_RE's bare "forbidden", and the codex lesson "retries burn quota" matched
// the exhausted rule. Three fixes, one per failure mode:
//   · stripPromptEcho — a prompt line reappearing in the err stream is the CLI REPLAYING what it
//     was told, not the CLI speaking; classification sees only the CLI's own output.
//   · looksLikeAuthDeath — the #5405 exit-0 escalation fires only on a SHORT error-only output
//     (the opencode "401 Unauthorized" specimen is a couple of lines); a long output is a real
//     answer, and a warning inside it must not fail the turn.
//   · classifyFailure — "exhausted" demands an explicit quota/rate-limit message; the broad bare
//     words ("credit", "balance", bare "insufficient") labelled ordinary prose on a dead turn and
//     sent the operator to wait out a window that did not exist.
import { readFileSync } from "node:fs";

export const AUTH_MARKER_RE = /unauthor|401|403|forbidden|invalid[ _-]?api[ _-]?key|authentication? failed|token expired/i;

/** Prompt lines (≥40 chars — a short line carries no signature) echoed back verbatim by the CLI
 *  are replay, not speech. Returns the err stream with those lines removed. */
export function stripPromptEcho(errText, promptText) {
  const text = String(errText || "");
  if (!promptText) return text;
  const echo = new Set(String(promptText).split("\n").filter(l => l.length >= 40));
  return text.split("\n").filter(l => !(l.length >= 40 && echo.has(l))).join("\n");
}

/** A real answer is long; an auth death is a couple of lines. The opencode specimen (#5405)
 *  printed its whole failure in under a hundred characters and produced nothing else. */
export const OWN_OUTPUT_ANSWER_MIN = 400;

/** The #5405 rule, refined by #5868: exit 0 + an auth-shaped marker means FAILED only when the
 *  CLI's own output is short enough to be JUST the error. */
export function looksLikeAuthDeath(ownText) {
  return String(ownText || "").length < OWN_OUTPUT_ANSWER_MIN && AUTH_MARKER_RE.test(ownText);
}

/** Classify one failed turn. Returns { reason, matched } — matched is the evidence excerpt the
 *  runner logs, so the next misclassification is diagnosable from the seat log alone. */
export function classifyFailure(exit, errText, emptyOutput = false) {
  // #5481: silence with a clean exit is a failure shape, not success — see lastEmptyOutput.
  if (emptyOutput) return { reason: "empty-output", matched: "exit 0 with no output on either stream" };
  const t = String(errText || "").toLowerCase();
  if (exit === 127) return { reason: "missing-cli", matched: "exit 127 — command not found" };
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
  return { reason: "crashed", matched: `exit ${exit} with no known failure pattern` };
}

/** Read the prompt file if it exists (the turn prompt the CLI may echo into its transcript). */
export function readPromptText(pf) {
  try { return readFileSync(pf, "utf8"); } catch { return ""; }
}
