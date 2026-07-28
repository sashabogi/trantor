// trantor — waking an IDLE peer session by typing into its terminal.
//
// The gap this closes: message delivery only reaches a session that is RUNNING. hooks/inbox-deliver.mjs
// is PostToolUse, so it fires while a session is mid-turn calling tools; a session sitting idle at the
// prompt fires no hooks and stays deaf. That is exactly the case that matters — agent A finishes, messages
// agent B *because* it finished, so B has been idle waiting the whole time. The human ends up being the
// message bus ("hey, crebral-health left you a message"), which is the one job the human shouldn't have.
//
// The mechanism is literally what a human does: type into the session's pane and hit return. On macOS,
// Terminal's `do script "…" in window id N` writes text + a return straight into that window's tty, which
// the program reading the tty receives as input — WITHOUT activating the window or stealing focus.
//
// WHY THIS LIVES IN A SESSION-CONTEXT PROCESS AND NOT THE HUB (verified 2026-07-28, do not "simplify"):
// the hub runs as a launchd agent (com.trantor.hub). macOS TCC gates one process controlling another app,
// and a launchd background job has no way to answer the Automation consent prompt — `osascript -e 'tell
// application "Terminal" …'` from that context HANGS with no output and no exit code. The identical command
// from a session-spawned process returns instantly. So the hub may DECIDE who needs waking (it holds the
// delivery state and the pane addresses), but only a descendant of the user's terminal session may EXECUTE
// it. A detached, orphaned child keeps the permission, which is what makes the deferred waker possible.
import { execFileSync } from "node:child_process";

export const isDarwin = () => process.platform === "darwin";

// AppleScript string literal escaping. Order matters: backslash first, or we'd escape our own escapes.
// Newlines are FLATTENED, not escaped: `do script` appends one return, so an embedded newline would submit
// the message in pieces — the first fragment lands as a whole prompt and the rest as separate ones.
export function escapeForAppleScript(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");   // control chars the tty would interpret
}

// Cap what we type in. A peer could send something enormous; a giant paste into someone's prompt is
// hostile, and the recipient can always read the full text with relay_inbox.
export const MAX_INJECT = Number(process.env.RELAY_WAKE_MAX_CHARS || 1200);

export function formatWakeText(from, text, msgId) {
  const body = String(text ?? "");
  const clipped = body.length > MAX_INJECT ? body.slice(0, MAX_INJECT) + ` […truncated, full text via relay_inbox]` : body;
  // Marked as bus traffic on purpose: the receiving agent must be able to tell a PEER's request from its
  // human's instruction. A peer asking for something destructive should not inherit the human's authority.
  return `[trantor] 📨 DIRECT from ${from} (bus message #${msgId}, delivered by waking this session): ${clipped}`;
}

function osa(script, timeoutMs = 8000) {
  // Multi-line scripts go via stdin, never a single -e arg: JSON/shell quoting turns the newlines into
  // literal \n and osascript dies with "Expected end of line but found unknown token". (Same trap
  // hooks/lib/handoff.mjs documents for terminalWindowForTty.)
  return execFileSync("osascript", [], { input: script, encoding: "utf8", timeout: timeoutMs }).trim();
}

// Re-validate before typing: only inject if the window is STILL the one on the tty we recorded. A window id
// is reused after a tab closes, so a stale address could type a peer's message into an UNRELATED window —
// the same class of mistake bin/baton-close.mjs guards against before it closes anything.
export function paneStillValid(windowId, tty) {
  if (!isDarwin() || !windowId || !tty) return false;
  try {
    const cur = osa(`tell application "Terminal"
  try
    return (tty of selected tab of (first window whose id is ${Number(windowId)})) as string
  on error
    return ""
  end try
end tell`);
    return cur === tty;
  } catch { return false; }
}

// Type `text` into the pane and press return. Returns true only if AppleScript accepted it.
export function injectIntoWindow(windowId, text) {
  if (!isDarwin() || !windowId) return false;
  try {
    osa(`tell application "Terminal" to do script "${escapeForAppleScript(text)}" in window id ${Number(windowId)}`);
    return true;
  } catch { return false; }
}

// The whole guarded operation, so callers can't skip the re-validation.
export function wakePane({ windowId, tty, text }) {
  if (!paneStillValid(windowId, tty)) return { ok: false, reason: "pane-invalid" };
  return injectIntoWindow(windowId, text) ? { ok: true } : { ok: false, reason: "inject-failed" };
}
