#!/usr/bin/env node
// #8778 drill — a 401 from chatgpt.com/backend-api is OpenAI rejecting its own subscription key
// server-side, not a dead login: every codex seat sat `codex login status` logged in, and the
// rejected sk-svcacct key existed in no env file, keychain or process env on the machine.
// The verdict reads provider-rejected, names the request id, never says "auth"; the reason parks.
import { classifyFailure, verdictFor, providerRejected } from "../../lib/classify-failure.mjs";
import { PARKING_REASONS, isBoundedPark } from "../../lib/turn-policy.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !extra ? "" : `\n          ${extra}`}`); cond ? pass++ : fail++; };

// The masked specimen (.agent-bus-out/codex-401-stderr.txt, key masked, duplicated line dropped).
const SPECIMEN = `OpenAI Codex v0.153.4
ERROR: unexpected status 401 Unauthorized: Incorrect API key provided: sk-svcac…MASKED You can find your API key at https://platform.openai.com/account/api-keys., url: https://chatgpt.com/backend-api/codex/responses, cf-ray: a40da0abfec625d0-BOS, request id: 33fd8ee1-37f8-45da-9317-6487a23d2215`;
const RID = "33fd8ee1-37f8-45da-9317-6487a23d2215";

console.log("# provider-rejected — the chatgpt-backend 401 that is not a login problem (#8778)");

console.log("\n## the real specimen classifies provider-rejected, never auth");
{
  const { reason, matched } = classifyFailure(1, SPECIMEN);
  ok("a 401 naming chatgpt.com/backend-api classifies provider-rejected", reason === "provider-rejected", reason);
  ok("the matched evidence names the request id", matched.includes(RID), matched);
  ok("the matched evidence names the endpoint", /chatgpt\.com\/backend-api/.test(matched), matched);
  const v = verdictFor(1, 1, false, SPECIMEN);
  ok("the verdict (non-zero exit) reads 'classified provider-rejected because …'", v.startsWith("classified provider-rejected because"), v);
  ok("the verdict never says auth — the login is valid", !/auth/i.test(v), v);
  ok("the verdict advises waiting or checking the OpenAI account", /wait or check the OpenAI account/.test(v), v);
  ok("the verdict says re-login will not help", /logging in again will not help/.test(v), v);
  // The path the real incident rode: codex printed the error and exited 0, the runner's
  // exit-0 escalation lifted effExit to 1, and THAT verdictFor branch spoke.
  const v0 = verdictFor(0, 1, false, SPECIMEN);
  ok("the exit-0 escalation path gives the same provider-rejected verdict", v0.startsWith("classified provider-rejected because"), v0);
  ok("the exit-0 verdict never says auth either", !/auth/i.test(v0), v0);
  ok("looksLikeAuthDeath still escalates the specimen (exit 0 → FAILED)", verdictFor(0, 1, false, SPECIMEN).includes(RID));
}

console.log("\n## every other 401 shape keeps its old reading");
{
  const apiKey = "ERROR: unexpected status 401 Unauthorized: Incorrect API key provided: sk-proj-REDACTED, url: https://api.openai.com/v1/responses, request id: 00000000-0000-0000-0000-000000000000";
  ok("a 401 from an API-key endpoint stays auth", classifyFailure(1, apiKey).reason === "auth",
    classifyFailure(1, apiKey).reason);
  ok("a 401 with no url at all stays auth", classifyFailure(1, "error: 401 unauthorized").reason === "auth");
  ok("a 403 from the chatgpt backend is not provider-rejected (rule is 401-only)",
    classifyFailure(1, "unexpected status 403 Forbidden, url: https://chatgpt.com/backend-api/codex/responses").reason === "auth",
    classifyFailure(1, "unexpected status 403 Forbidden, url: https://chatgpt.com/backend-api/codex/responses").reason);
  const fivehundred = "unexpected status 500 Internal Server Error, url: https://chatgpt.com/backend-api/codex/responses";
  ok("a 5xx from the chatgpt backend stays backend-error", classifyFailure(1, fivehundred).reason === "backend-error",
    classifyFailure(1, fivehundred).reason);
  ok("a 429 stays exhausted even on the chatgpt backend",
    classifyFailure(1, "429 too many requests, url: https://chatgpt.com/backend-api/codex/responses").reason === "exhausted");
  ok("providerRejected() is null for a 401 that names no chatgpt endpoint",
    providerRejected(apiKey) === null && providerRejected("error: 401 unauthorized") === null);
  ok("providerRejected() is null for a 5xx on the same endpoint", providerRejected(fivehundred) === null);
  ok("providerRejected() is null for text with no 401 at all",
    providerRejected("connection refused, url: https://chatgpt.com/backend-api/codex/responses") === null);
}

console.log("\n## the reason parks the seat instead of redelivering into the same wall");
{
  ok("provider-rejected is a PARKING reason", PARKING_REASONS.has("provider-rejected"));
  ok("the park is unbounded — it holds until trantor up, like auth", isBoundedPark("provider-rejected") === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
