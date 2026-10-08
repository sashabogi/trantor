#!/usr/bin/env node
// #11360 drill — exit 143 is 128+15, SIGTERM: a DIRECT kill of the CLI pid. A SIGTERM is always
// someone on this machine ending the CLI, so it classifies "killed" ahead of every text pattern
// (the specimen's tail tripped AUTH_MARKER_RE), same signal-exit family as 141/137, never auth.
import {
  cutSignalFor, classifyFailure, verdictFor,
} from "../../lib/classify-failure.mjs";
import { PARKING_REASONS } from "../../lib/turn-policy.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };

// The specimen's shape: a deliberate SIGTERM over a capture whose tail carries auth-shaped text
// (the kimi CLI's error banner names 403 on its quota deaths — #11389's family).
const KILLED_TAIL = `error: failed to run prompt: provider.auth_error: 403 You've reached your weekly (7-day) usage limit.
See log: /Users/<user>/.kimi-code/logs/kimi-code.log`;

console.log("# cut-kill — exit 143 (SIGTERM) is a kill, not an auth death (#11360)");

console.log("\n## the rules");
{
  ok("143 IS a cut signal — SIGTERM, a direct kill of the CLI pid", cutSignalFor(143) === "SIGTERM",
    `got ${JSON.stringify(cutSignalFor(143))}`);
  ok("141/137 keep their signals, anything else is still none",
    cutSignalFor(141) === "SIGPIPE" && cutSignalFor(137) === "SIGKILL" && cutSignalFor(0) === "" && cutSignalFor(1) === "");
  ok("143 classifies killed over an auth-shaped tail, never auth",
    classifyFailure(143, KILLED_TAIL).reason === "killed",
    JSON.stringify(classifyFailure(143, KILLED_TAIL)));
  ok("143 classifies killed with NO text at all, never crashed",
    classifyFailure(143, "").reason === "killed",
    JSON.stringify(classifyFailure(143, "")));
  ok("143 outranks the quota patterns too — the kill is the whole story",
    classifyFailure(143, "rate limit exceeded, quota gone").reason === "killed",
    JSON.stringify(classifyFailure(143, "rate limit exceeded, quota gone")));
  ok("143 outranks the backend patterns too",
    classifyFailure(143, "unexpected status 502 bad gateway").reason === "killed",
    JSON.stringify(classifyFailure(143, "unexpected status 502 bad gateway")));
  ok("the matched evidence names the signal, not the CLI's last words",
    /SIGTERM/.test(classifyFailure(143, KILLED_TAIL).matched),
    classifyFailure(143, KILLED_TAIL).matched);
  ok("143 under the cut marker is still killed (a sweep SIGTERM would read the same)",
    classifyFailure(143, KILLED_TAIL, false, false, true).reason === "killed");
}

console.log("\n## the verdict and the ladder");
{
  const v = verdictFor(143, 143, false, KILLED_TAIL);
  ok("the verdict reads classified killed", v.startsWith("classified killed because"), v);
  ok("the verdict never says auth", !/\bauth\b/.test(v), v);
  ok("killed is NOT a parking reason — the credentials are fine, the next wake just runs",
    !PARKING_REASONS.has("killed"), [...PARKING_REASONS].join(", "));
  ok("auth still classifies auth on an honest exit 1 — the rule does not swallow the family",
    classifyFailure(1, KILLED_TAIL).reason === "exhausted"
      && classifyFailure(1, "error: 401 unauthorized").reason === "auth",
    JSON.stringify(classifyFailure(1, "error: 401 unauthorized")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
