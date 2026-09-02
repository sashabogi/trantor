// Regression for #5868: the codex seat sat "DOWN — 44 consecutive failures (exhausted)" while
// every telemetry row read exit:0 and the transcript showed real work. Both labels came from the
// seat's own PROMPT echoing through the transcript: the rules line "…deleting failing tests is
// forbidden." matched AUTH_MARKER_RE's bare "forbidden" ("FAILED (exit 1, auth)"), and the codex
// lesson "retries burn quota" matched the exhausted rule. Fixtures below are the REAL excerpts
// from ~/.agent-bus/err-codex-trantor.txt plus the classic failure specimens (#5405 opencode
// auth, #5683 codex compact-404, Claude's usage-limit notice).
import { strict as assert } from "node:assert";
import {
  AUTH_MARKER_RE, OWN_OUTPUT_ANSWER_MIN, classifyFailure, looksLikeAuthDeath, stripPromptEcho, verdictFor,
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

console.log("# the qwen specimen — contract echo the exact-match strip provably missed (#5868 turn 9)");
{
  // The REAL contract (the #6049 wake text) — ABOUT a hub 401, dense with auth vocabulary.
  const QWEN_PROMPT = [
    "Queued after the anti-slop card (finish and commit that first): card #6049, medium. Genesis drill on trantor 0.18.30: `trantor new genesis-drill-2 --brief … --dir … --json` printed \"hub unreachable or refusing (hub 401 on /project)\" and card:null — the project exists locally, hub pin set, but the brief and first card never reached the board.",
    "The hub's 401 reasons (hub.mjs ~1015–1065, 1318, 1369): \"signature required\", \"unknown identity\" (a signed request from a not-yet-enrolled identity — see the comment at ~1020), \"bad signature\". Steps: (1) make the CLI's error carry the hub's error body (`hub 401 on /project: unknown identity`) — always; (2) reproduce INSIDE your worktree (the seat sandbox rejects writes outside it).",
  ].join("\n");
  // How the CLI actually echoed it: '>' framing, terminal-width wrapping, its own progress lines
  // between — NO echoed line equals a prompt line, which is exactly why 9b28036's exact-match
  // strip removed nothing and the raw text went on to match AUTH_MARKER_RE.
  const QWEN_ERR = [
    "\x1b[2mworktree\x1b[0m seat/qwen clean",
    "> Queued after the anti-slop card (finish and commit that first): card #6049, medium. Genesis drill on trantor",
    "> 0.18.30: `trantor new genesis-drill-2 --brief … --dir … --json` printed \"hub unreachable or refusing (hub 401",
    "> on /project)\" and card:null — the project exists locally, hub pin set, but the brief and first card never",
    "> reached the board. The hub's 401 reasons (hub.mjs ~1015–1065, 1318, 1369): \"signature required\", \"unknown",
    "> identity\" (a signed request from a not-yet-enrolled identity — see the comment at ~1020), \"bad signature\".",
    "\x1b[32m●\x1b[0m committed aa3c340 (test-new.mjs, bin/new.mjs)",
  ].join("\n");
  const norm = (l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\s+/g, " ").trim();
  const echoedLine = norm(QWEN_ERR.split("\n")[2]);
  ok(!QWEN_PROMPT.split("\n").map(norm).includes(echoedLine),
    "evidence: no echoed line is a verbatim prompt line — the old exact-match strip provably missed it");
  ok(AUTH_MARKER_RE.test(QWEN_ERR) === true, "evidence: the raw echoed contract really did match AUTH_MARKER_RE ('401')");
  const own = stripPromptEcho(QWEN_ERR, QWEN_PROMPT);
  ok(!AUTH_MARKER_RE.test(own), "the new strip removes the framed/wrapped contract echo — no auth marker survives");
  ok(own.includes("committed aa3c340"), "the CLI's own work lines survive the strip");
  ok(looksLikeAuthDeath(own) === false, "stripped qwen output is NOT an auth death");
  ok(looksLikeAuthDeath(QWEN_ERR, true) === false,
    "belt and braces: a turn that shipped a commit is NEVER auth, even on the raw echo");
  ok(looksLikeAuthDeath("401 Unauthorized", false) === true,
    "a genuine short auth death with no real work still escalates (#5405 specimen)");
}

console.log("# stripPromptEcho — short-line VERBATIM echoes (#6110): under-40-char lines were never");
console.log("# matched against the prompt at all, so a short echoed wake fragment carrying '401'/'403'/");
console.log("# 'auth' survived and, with exit 0 and no new commit, tripped looksLikeAuthDeath on a turn");
console.log("# that never touched auth.");
{
  // (a) the prompt CONTAINS a short auth-shaped phrase; the CLI's own output is exactly that phrase
  // (an echoed wake fragment) plus a real one-word answer. The echo must be stripped so the auth
  // marker doesn't survive into the classifier — leaving "done", which is not an auth death.
  const shortPrompt = "Before you start: check the 401 on the hub, then continue with the migration.";
  const echoedShort = "check the 401 on the hub\ndone";
  const strippedShort = stripPromptEcho(echoedShort, shortPrompt);
  ok(!strippedShort.includes("401"), "a short echoed wake fragment ('check the 401 on the hub') is stripped");
  ok(strippedShort.includes("done"), "the CLI's own one-word answer survives the strip");
  ok(looksLikeAuthDeath(strippedShort) === false,
    "exit 0, no new commit, short output that was JUST a prompt echo → not auth (#6110 a)");

  // (b) the prompt never mentions 401 at all; the CLI's own short output genuinely IS "401
  // Unauthorized". Nothing to strip (it's not in the prompt), so it must still escalate.
  const noAuthPrompt = "Ship the migration and update the changelog when it lands.";
  const genuineShort = "401 Unauthorized";
  const strippedGenuine = stripPromptEcho(genuineShort, noAuthPrompt);
  ok(strippedGenuine === genuineShort, "a genuine short CLI error absent from the prompt is untouched by the strip");
  ok(looksLikeAuthDeath(strippedGenuine) === true,
    "exit 0, short output, genuine 401 not present in the prompt → still auth (#6110 b)");
}

console.log("# the seat-log verdict line (contract c): every classification carries evidence");
{
  for (const [exit, text, empty] of [[1, "quota ran out", false], [1, "401 unauthorized", false], [1, "unexpected status 502", false], [127, "", false], [0, "", true]]) {
    const { reason, matched } = classifyFailure(exit, text, empty);
    ok(reason.length > 0 && matched.length > 0 && `classified ${reason} because ${matched}`.startsWith("classified "),
      `[runner] classified ${reason} because ${matched}`);
  }
}

console.log("# verdictFor — the verdict field that rides the seat's jsonl row (#5868)");
{
  ok(verdictFor(0, 0, false, "did the work") === "classified success because exit 0 with CLI output",
    "clean turn → classified success");
  ok(verdictFor(0, 1, true, "") === "classified empty-output because exit 0 with no output on either stream",
    "#5481 escalation → empty-output verdict");
  const authV = verdictFor(0, 1, false, "401 Unauthorized");
  ok(authV === "classified auth because 401 in the CLI's own short output", `exit-0 escalation → ${authV}`);
  ok(verdictFor(1, 1, false, "You've reached your usage limit.").startsWith("classified exhausted"),
    "non-zero turn → the classifyFailure verdict verbatim");
  ok(verdictFor(1, 1, false, "segfault").startsWith("classified crashed"), "unknown failure → crashed");
}


console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
