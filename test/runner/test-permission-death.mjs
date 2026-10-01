#!/usr/bin/env node
// #9919 drill — a sandbox permission rejection rode a clean exit to "classified success": the seat
// reached outside its worktree, opencode killed the turn at exit 0, and the runner read success.
// Both real specimens live in fixtures (unmasked): permission-ibkr-tail.txt and
// permission-trantor-tail.txt — the second is this seat's own earlier turn, dead the same way.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyFailure, verdictFor, looksLikePermissionDeath, permissionRejection,
  PERMISSION_RE, PERMISSION_TAIL,
} from "../../lib/classify-failure.mjs";
import { PARKING_REASONS } from "../../lib/turn-policy.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const IBKR = readFileSync(join(FIXTURES, "permission-ibkr-tail.txt"), "utf8");
const TRANTOR = readFileSync(join(FIXTURES, "permission-trantor-tail.txt"), "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };

console.log("# permission-rejected — the sandbox rejection that exited 0 and read success (#9919)");

console.log("\n## the real specimens classify permission-rejected, never success");
{
  ok("looksLikePermissionDeath sees the ibkr specimen", looksLikePermissionDeath(IBKR) === true);
  ok("...and the trantor specimen (this seat's own dead turn)", looksLikePermissionDeath(TRANTOR) === true);
  const v = verdictFor(0, 0, false, IBKR, false, false);
  ok("verdictFor(exit 0, exit 0, ibkr) reads classified permission-rejected", v.startsWith("classified permission-rejected because"), v);
  ok("the verdict names the refused path", v.includes("/tmp/w0-base/*"), v);
  ok("the verdict never says success", !/success/.test(v), v);
  const vt = verdictFor(0, 0, false, TRANTOR, false, false);
  ok("the trantor verdict names its own refused path", vt.startsWith("classified permission-rejected") && vt.includes("/Users/sashabogojevic/.agent-bus/*"), vt);
  const v1 = verdictFor(0, 1, false, IBKR, false, false);
  ok("the lifted-exit path names permission-rejected too", v1.startsWith("classified permission-rejected because"), v1);
  ok("classifyFailure(exit 1, ibkr) is permission-rejected, never crashed",
    classifyFailure(1, IBKR).reason === "permission-rejected", JSON.stringify(classifyFailure(1, IBKR)));
  ok("the matched evidence carries the refused path or the tool-call error",
    /auto-reject|rejected permission to use this specific tool call/i.test(classifyFailure(1, IBKR).matched),
    classifyFailure(1, IBKR).matched);
}

console.log("\n## the guard keeps the doctrine — real work stands, quoting the phrase is not dying");
{
  ok("a shipped commit is real work — never re-labelled", looksLikePermissionDeath(IBKR, true) === false);
  // The ibkr capture is 1.3KB of real work (git log, pytest) ABOVE the rejection — the billing
  // rule's whole-text answer floor (#9812) would miss it; the TAIL is the judged zone.
  ok("the ibkr capture is longer than the billing answer floor — the tail is what judges",
    IBKR.length >= 400 && looksLikePermissionDeath(IBKR) === true);
  ok("an honest answer that never mentions the phrase classifies success",
    verdictFor(0, 0, false, "Done — built and tested, all green.", false, false) === "classified success because exit 0 with CLI output");
}

console.log("\n## a long turn that only QUOTES the phrase mid-stream stays success (#9812 doctrine)");
{
  const PHRASE = "Error: The user rejected permission to use this specific tool call.";
  // A contract/commit-message quote sits mid-turn; the turn went on and finished — 600+ chars of
  // answer AFTER the quote push it out of the tail window.
  const QUOTING_TURN = `The old runner had a bug: ${PHRASE} printed on a clean exit.\n\n${"Fixed in lib/classify-failure.mjs — the classifier now judges the tail. ".repeat(16)}`;
  ok("the quote sits outside the judged tail", QUOTING_TURN.indexOf(PHRASE) < QUOTING_TURN.length - PERMISSION_TAIL);
  ok("a mid-stream quote is not a permission death", looksLikePermissionDeath(QUOTING_TURN) === false);
  ok("its verdict is success, never permission-rejected",
    verdictFor(0, 0, false, QUOTING_TURN, false, false) === "classified success because exit 0 with CLI output",
    verdictFor(0, 0, false, QUOTING_TURN, false, false));
  // Boundary: the phrase is IN the tail when the turn ends on it, OUT when ≥PERMISSION_TAIL chars
  // of real answer follow it.
  ok("a turn ENDING on the phrase (tail edge) still trips",
    looksLikePermissionDeath(`${"work\n".repeat(40)}${PHRASE}`) === true);
  ok("the phrase followed by a full tail-window of answer does not",
    looksLikePermissionDeath(`${PHRASE}${"then the turn kept going and finished the work. ".repeat(14)}`) === false);
  ok("empty output is no death", looksLikePermissionDeath("") === false);
}

console.log("\n## the regex carries both contract phrases; the evidence names the path when printed");
{
  ok("the tool-call rejection phrase matches", PERMISSION_RE.test("Error: The user rejected permission to use this specific tool call."));
  ok("the auto-reject banner phrase matches", PERMISSION_RE.test("! permission requested: external_directory (/tmp/w0-base/*); auto-rejecting"));
  ok("permissionRejection extracts the refused path",
    permissionRejection(IBKR) === "the sandbox auto-rejected permission for /tmp/w0-base/*",
    permissionRejection(IBKR));
  ok("a bare tool-call error with no banner still yields evidence",
    /rejected permission to use this specific tool call/.test(permissionRejection("Error: The user rejected permission to use this specific tool call.")),
    permissionRejection("Error: The user rejected permission to use this specific tool call."));
  ok("no rejection yields null evidence", permissionRejection("all quiet") === null);
}

console.log("\n## the reason is a report, not a wall");
{
  // Unlike exhausted/auth, a corrected contract fixes a permission death — this very redelivery
  // (specimens moved INSIDE the worktree) succeeded where the first contract died. So it ladders
  // and bound-parks instead of holding for `trantor up`.
  ok("permission-rejected is NOT a PARKING reason", !PARKING_REASONS.has("permission-rejected"));
  ok("exhausted still is", PARKING_REASONS.has("exhausted"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
