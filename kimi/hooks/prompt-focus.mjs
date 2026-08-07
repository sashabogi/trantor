#!/usr/bin/env node
// trantor UserPromptSubmit hook — Kimi Code port. Two jobs:
//   1. FOCUS CARD: turn each substantive user prompt into the session's live "focus" card on the
//      board (one rolling card per session; the hub re-titles it as the focus shifts).
//   2. STARTUP-CONTEXT DELIVERY: Kimi's SessionStart is observation-only, so sessionstart.mjs
//      stashed the roster/catch-up/handoff block; UserPromptSubmit stdout is DOCUMENTED to append
//      to context, so we emit the stash here on the session's first real prompt and clear it.
// Fail-silent + fast: NO LLM call. Never blocks or delays the turn.
import { readPayload, payloadCwd, isHomeSession, identity, relayUrl, jpost, extractPrompt, debugHook, takeStash } from "./lib/common.mjs";

// A prompt that is JUST an acknowledgement/continuation (anchored to end) — not a new focus.
const ACK = /^(y|yes|yep|yeah|ok|okay|sure|go|go ahead|continue|proceed|do it|please|thanks|thank you|ty|next|k|cool|nice|great|perfect|sounds good|👍)[\s.!]*$/i;
function titleFrom(prompt) {
  let s = String(prompt || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^(please|can you|could you|would you|hey,?|ok,?|now,?|let's|lets|i want you to|i'd like you to|i need you to|go ahead and)\s+/i, "");
  return s.slice(0, 120);
}

let session = "";
try {
  const payload = await readPayload();
  debugHook("UserPromptSubmit", payload);
  const cwd = payloadCwd(payload);
  if (isHomeSession(cwd)) process.exit(0);
  ({ session } = identity(cwd));
  const { project } = identity(cwd);

  const prompt = extractPrompt(payload);
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  // skip empties, tiny continuations, and pure acks — they're not a new focus
  if (trimmed && trimmed.length >= 12 && !ACK.test(trimmed)) {
    await jpost(`${relayUrl()}/focus`, {
      session, project, title: titleFrom(trimmed), by: session,
    }, 1500);
  }
} catch (e) {
  process.stderr.write(`[trantor] kimi prompt-focus error: ${e?.message || e}\n`);
}

// Inject any pending startup context (roster / board catch-up / handoff) — this event's stdout
// is the one Kimi documents as appended to the model's context. Empty when nothing was stashed.
try {
  if (session) {
    const pending = takeStash(session);
    if (pending) process.stdout.write(pending + "\n");
  }
} catch {}
process.exit(0);
