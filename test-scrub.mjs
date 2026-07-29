#!/usr/bin/env node
// trantor — tests for lib/scrub.mjs, the last line before a secret enters an append-only log.
// Two failure modes matter equally: missing a real secret (unrecoverable), and flagging Trantor's
// OWN protocol traffic (pubkeys, body hashes) which would break enrollment.
import { findSecrets, redact, assertNoSecrets } from "./lib/scrub.mjs";
import { generate, bodyHash } from "./lib/identity.mjs";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${e ? " — " + e : ""}`); } };
const flagged = s => !assertNoSecrets(s).ok;

console.log("\nReal secrets MUST be caught:");
const secrets = {
  "openai/openrouter key": "sk-abcdefghijklmnopqrstuvwxyz012345",
  "stripe live key":       "sk_live_abcdefghijklmnop1234",
  "xai key":               "xai-abcdefghijklmnopqrst1234",
  "aws access key id":     "AKIAIOSFODNN7EXAMPLE",
  "github pat":            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "google api key":        "AIzaSyDRabcdefghijklmnopqrstuvwxyz01234",
  "slack token":           "xoxb-1234567890-abcdefghij",
  "jwt":                   "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  "bearer token":          "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123",
  "pem private key":       "-----BEGIN RSA PRIVATE KEY-----",
  "pem private key plain": "-----BEGIN PRIVATE KEY-----",
};
for (const [k, v] of Object.entries(secrets)) ok(k, flagged(v), JSON.stringify(v).slice(0, 40));

console.log("\nTrantor's OWN legitimate traffic must PASS (this is what the cheap draft got wrong):");
const id = generate();
ok("Ed25519 PUBLIC key (sent by /enroll, returned by /peers)", !flagged(id.pubkey), id.pubkey.slice(0, 20));
ok("sha256 body hash (in the canonical request string)", !flagged(bodyHash("hello world")));
ok("a peers payload containing a pubkey", !flagged(JSON.stringify({ session: "h:a", pubkey: id.pubkey })));
ok("40-char git SHA", !flagged("a".repeat(40)));
ok("prose mentioning api_key/password/secret", !flagged("the api_key and password come from env; never a secret in code"));
ok("a commit message citing a SHA", !flagged("fixed in b20882d, see also 9a0f3ad"));

console.log("\nBut a private key WITH intent context is caught:");
ok('{"privkey":"<64hex>"} is flagged', flagged(`{"privkey":"${id.privkey}"}`));
ok("'private key: <64hex>' is flagged", flagged(`private key: ${id.privkey}`));
ok("'seed = <64hex>' is flagged", flagged(`seed = ${id.privkey}`));

console.log("\nredact():");
{
  const r = redact("use sk-abcdefghijklmnopqrstuvwxyz012345 now");
  ok("replaces the secret", !r.includes("sk-abcdefghijklmnop"), r);
  ok("marks the kind", r.includes("[REDACTED:openai-key]"), r);
  ok("keeps surrounding text", r.startsWith("use ") && r.endsWith(" now"), r);
  ok("clean text is returned unchanged", redact("nothing here") === "nothing here");
  const two = redact("sk-aaaaaaaaaaaaaaaaaaaa and AKIAIOSFODNN7EXAMPLE");
  ok("redacts multiple secrets", (two.match(/\[REDACTED:/g) || []).length === 2, two);
}

console.log("\nNever throws, whatever it is handed:");
for (const [label, v] of [["null", null], ["undefined", undefined], ["number", 42], ["object", { a: 1 }],
                          ["array", [1, 2]], ["emoji", "📨🔑"], ["empty", ""], ["100k chars", "a".repeat(100000)]]) {
  let threw = false;
  try { findSecrets(v); redact(v); assertNoSecrets(v); } catch { threw = true; }
  ok(`${label} handled`, !threw);
}

console.log("\nStructure:");
{
  const f = findSecrets("sk-abcdefghijklmnopqrstuvwxyz012345");
  ok("returns {kind,index,length}", f.length === 1 && typeof f[0].kind === "string" && Number.isInteger(f[0].index) && f[0].length > 0);
  ok("assertNoSecrets reports unique kinds", assertNoSecrets("sk-aaaaaaaaaaaaaaaaaaaa sk-bbbbbbbbbbbbbbbbbbbb").kinds.length === 1);
  ok("clean text -> {ok:true}", assertNoSecrets("hello").ok === true);
  const t0 = Date.now(); findSecrets(("x".repeat(200) + " sk-aaaaaaaaaaaaaaaaaaaa ").repeat(200));
  ok("no catastrophic backtracking (<1s on 40k chars)", Date.now() - t0 < 1000, (Date.now() - t0) + "ms");
}

console.log(`\ntest-scrub: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
