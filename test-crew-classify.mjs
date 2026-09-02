// Regression for #5868: the codex seat sat "DOWN — 44 consecutive failures (exhausted)" while
// every telemetry row read exit:0 and the transcript showed real work. Both labels came from the
// seat's own PROMPT echoing through the transcript: the rules line "…deleting failing tests is
// forbidden." matched AUTH_MARKER_RE's bare "forbidden" ("FAILED (exit 1, auth)"), and the codex
// lesson "retries burn quota" matched the exhausted rule. Fixtures below are the REAL excerpts
// from ~/.agent-bus/err-codex-trantor.txt plus the classic failure specimens (#5405 opencode
// auth, #5683 codex compact-404, Claude's usage-limit notice).
import { strict as assert } from "node:assert";
import {
  AUTH_MARKER_RE, OWN_OUTPUT_ANSWER_MIN, classifyFailure, looksLikeAuthDeath, stripPromptEcho,
} from "./lib/classify-failure.mjs";

let fail = 0; const ok = (c, m) => { console.log((c ? "✓" : "✗ FAIL") + " " + m); if (!c) fail++; };
const same = (a, b, m) => { try { assert.deepStrictEqual(a, b); ok(true, m); } catch (e) { ok(false, `${m} — got ${JSON.stringify(a)?.slice(0, 120)}`); } };

// --- the real evidence, verbatim from err-codex-trantor.txt (2026-09-02) ---
const RULES_LINE =
  "- [global] Never edit files owned by another agent — if your change breaks their tests, message the owner with what changed and let them update; deleting failing tests is forbidden.";
const QUOTA_LESSON_LINE =
  '- [codex] If a codex turn crashes with "remote compact ... 404" the session has hit its context window and resume is permanently wedged — relaunch the seat fresh (trantor up codex) instead of letting the runner retry; retries burn quota and can never succeed.';
const CREW_ENV_LINE =
  "- [global] Never `trantor up` at phase kickoff by reflex: sweep relay_peers first — a LIVE seat only needs a relay_send contract (its runner wakes it); re-upping a live seat forks a duplicate session on the same bus label, causing duplicate reports and misrouted messages. Only up seats that are confirmed dead.";
const REAL_ANSWER_TAIL = [
  "hook: SessionStart",
  "hook: SessionStart Completed",
  "hook: UserPromptSubmit",
  "codex",
  "Stale runner-loop receipts and readiness broadcasts only; no new contract. Ending turn.",
  "hook: Stop",
  "hook: Stop Completed",
  "tokens used",
  "4,387",
].join("\n");

// A healthy codex turn: the prompt echo (with its trigger words) PLUS a real answer.
const HEALTHY_ERR = [RULES_LINE, QUOTA_LESSON_LINE, CREW_ENV_LINE, REAL_ANSWER_TAIL].join("\n");
const PROMPT = [RULES_LINE, QUOTA_LESSON_LINE, CREW_ENV_LINE].join("\n");

console.log("# stripPromptEcho — the echo is replay, not the CLI speaking");
{
  const own = stripPromptEcho(HEALTHY_ERR, PROMPT);
  ok(!own.includes("forbidden"), "echoed rules line ('…is forbidden.') is stripped");
  ok(!own.includes("burn quota"), "echoed codex lesson ('retries burn quota') is stripped");
  ok(own.includes("tokens used") && own.includes("Stale runner-loop receipts"), "the CLI's own answer survives");
  ok(stripPromptEcho("codex\nhook: Stop\n4,387", PROMPT).split("\n").length === 3, "short lines survive even when prompt-like");
  ok(stripPromptEcho(HEALTHY_ERR, "") === HEALTHY_ERR, "no prompt on disk → text passes through unchanged");
}

console.log("# looksLikeAuthDeath — the #5405 exit-0 escalation, narrowed by #5868");
{
  // The old false trigger, pinned as evidence: the RAW transcript matched the auth regex.
  ok(AUTH_MARKER_RE.test(HEALTHY_ERR) === true, "evidence: the raw echo really did match AUTH_MARKER_RE");
  const own = stripPromptEcho(HEALTHY_ERR, PROMPT);
  ok(looksLikeAuthDeath(own) === false, "the real healthy codex turn is NOT an auth death");
  const longAnswer = "Done. Note: the legacy endpoint answered 401 once before retry succeeded.\n" + "x".repeat(OWN_OUTPUT_ANSWER_MIN);
  ok(looksLikeAuthDeath(longAnswer) === false, "a long own output is a real answer despite a 401 mention (contract a)");
  ok(looksLikeAuthDeath("401 Unauthorized") === true, "the #5405 specimen — short output that IS the error — still escalates");
  ok(looksLikeAuthDeath("Invalid API key provided") === true, "…and so does the Invalid-API-key specimen");
}

console.log("# classifyFailure — reasons and the matched evidence");
{
  const own = stripPromptEcho(HEALTHY_ERR, PROMPT);
  same(classifyFailure(1, own), { reason: "crashed", matched: "exit 1 with no known failure pattern" },
    "a stripped healthy turn that still failed exits as crashed, not auth/exhausted");
  same(classifyFailure(1, "You've reached your usage limit. Your next reset is 15:00").reason, "exhausted",
    "Claude's usage-limit notice → exhausted (earliest alternation wins: 'reached your usage limit')");
  ok(classifyFailure(1, "You've reached your usage limit. Your next reset is 15:00").matched.includes("limit"),
    "…and the matched evidence names the limit phrase");
  same(classifyFailure(1, "429 too many requests, retry after 30s").matched, "429",
    "429 → exhausted (falls through backend-error by design)");
  same(classifyFailure(1, "quota exceeded for this billing period").reason, "exhausted", "explicit quota → exhausted");
  ok(classifyFailure(1, "insufficient documentation in the PR body").reason !== "exhausted", "bare 'insufficient' is no longer exhausted");
  ok(classifyFailure(1, "the balance of trade shifted").reason !== "exhausted", "bare 'balance' is no longer exhausted");
  ok(classifyFailure(1, "he had credit in the bank").reason !== "exhausted", "bare 'credit' is no longer exhausted");
  same(classifyFailure(1, "WARNING: Unexpected status 404 Not Found from POST /responses/compact"),
    { reason: "backend-error", matched: "unexpected status 404" }, "#5683 specimen keeps backend-error");
  same(classifyFailure(1, "error: 401 unauthorized").reason, "auth", "auth on the CLI's own error output");
  same(classifyFailure(127, ""), { reason: "missing-cli", matched: "exit 127 — command not found" }, "missing-cli keeps its reason");
  same(classifyFailure(0, "", true), { reason: "empty-output", matched: "exit 0 with no output on either stream" }, "empty-output keeps its reason");
}

console.log("# the seat-log verdict line (contract c): every classification carries evidence");
{
  for (const [exit, text, empty] of [[1, "quota ran out", false], [1, "401 unauthorized", false], [1, "unexpected status 502", false], [127, "", false], [0, "", true]]) {
    const { reason, matched } = classifyFailure(exit, text, empty);
    ok(reason.length > 0 && matched.length > 0 && `classified ${reason} because ${matched}`.startsWith("classified "),
      `[runner] classified ${reason} because ${matched}`);
  }
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
