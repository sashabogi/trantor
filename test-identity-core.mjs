#!/usr/bin/env node
// trantor — unit tests for the identity PRIMITIVES (lib/identity.mjs + lib/signed-fetch.mjs).
//
// Scope boundary: this file tests the crypto and the key file in isolation. The end-to-end
// adversarial suite against a running hub (enrollment, RELAY_AUTH modes, scope filtering,
// from-spoofing, non-loopback refusal) lives in test-identity.mjs and is owned separately.
//
// These are deliberately adversarial: a signature bug fails SILENTLY and looks like success, so
// every test here is "does the wrong thing get REJECTED", not "does the right thing work".
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "trantor-idcore-"));
process.env.AGENT_BUS_DIR = dir;                 // must be set BEFORE importing the module

const { generate, loadOrCreate, load, publicView, keyPath, bodyHash, canonicalString,
        signRequest, verifyRequest, SKEW_MS, HDR } = await import("./lib/identity.mjs");
const { signedHeaders, sfetch } = await import("./lib/signed-fetch.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); } };

const REQ = { method: "POST", path: "/send", body: JSON.stringify({ from: "a", text: "hi" }) };
const idA = { ...generate(), name: "a", kind: "agent" };
const idB = { ...generate(), name: "b", kind: "agent" };
const hdrsFor = (id, req = REQ) => signRequest(id, req);

console.log("\nKey generation:");
ok("pubkey is 32 bytes of hex", /^[0-9a-f]{64}$/.test(idA.pubkey));
ok("privkey is 32 bytes of hex", /^[0-9a-f]{64}$/.test(idA.privkey));
ok("two identities differ", idA.pubkey !== idB.pubkey);
ok("pubkey is not the privkey", idA.pubkey !== idA.privkey);

console.log("\nSign / verify round trip:");
{
  const headers = hdrsFor(idA);
  const r = verifyRequest({ headers, ...REQ });
  ok("a correctly signed request verifies", r.ok, r.reason);
  ok("verification reports the signing pubkey", r.pubkey === idA.pubkey);
  const g = { method: "GET", path: "/peers?project=x", body: undefined };
  ok("a GET with no body verifies", verifyRequest({ headers: hdrsFor(idA, g), ...g }).ok);
}

console.log("\nTampering is rejected:");
{
  const headers = hdrsFor(idA);
  ok("tampered BODY rejected", !verifyRequest({ headers, ...REQ, body: JSON.stringify({ from: "a", text: "evil" }) }).ok);
  ok("tampered PATH rejected", !verifyRequest({ headers, ...REQ, path: "/project/delete" }).ok);
  ok("tampered METHOD rejected", !verifyRequest({ headers, ...REQ, method: "DELETE" }).ok);
  ok("tampered QUERY rejected", !verifyRequest({ headers, ...REQ, path: "/send?admin=1" }).ok);
  ok("swapped pubkey rejected", !verifyRequest({ headers: { ...headers, [HDR.pubkey]: idB.pubkey }, ...REQ }).ok);
  ok("mangled signature rejected", !verifyRequest({ headers: { ...headers, [HDR.sig]: Buffer.from("nope").toString("base64") }, ...REQ }).ok);
  ok("signature from another key rejected", !verifyRequest({ headers: { ...hdrsFor(idB), [HDR.pubkey]: idA.pubkey }, ...REQ }).ok);
}

console.log("\nFreshness:");
{
  const headers = hdrsFor(idA);
  const t = Number(headers[HDR.ts]);
  ok("fresh timestamp accepted", verifyRequest({ headers, ...REQ, now: t + 1000 }).ok);
  ok("expired timestamp rejected", verifyRequest({ headers, ...REQ, now: t + SKEW_MS + 1000 }).reason === "stale");
  ok("far-future timestamp rejected", verifyRequest({ headers, ...REQ, now: t - SKEW_MS - 1000 }).reason === "stale");
  ok("edited ts breaks the signature", !verifyRequest({ headers: { ...headers, [HDR.ts]: String(t + 5) }, ...REQ }).ok);
}

console.log("\nMalformed input is rejected, never thrown:");
{
  ok("no headers at all -> unsigned", verifyRequest({ headers: {}, ...REQ }).reason === "unsigned");
  const headers = hdrsFor(idA);
  for (const k of Object.values(HDR)) {
    const missing = { ...headers }; delete missing[k];
    ok(`missing ${k} -> unsigned`, verifyRequest({ headers: missing, ...REQ }).reason === "unsigned");
  }
  ok("non-hex pubkey rejected", verifyRequest({ headers: { ...headers, [HDR.pubkey]: "zz" }, ...REQ }).reason === "bad-pubkey");
  ok("short nonce rejected", verifyRequest({ headers: { ...headers, [HDR.nonce]: "abc" }, ...REQ }).reason === "bad-nonce");
  ok("non-numeric ts rejected", verifyRequest({ headers: { ...headers, [HDR.ts]: "later" }, ...REQ }).reason === "bad-ts");
  ok("a Headers object works too", verifyRequest({ headers: new Headers(hdrsFor(idA)), ...REQ }).ok);
}

console.log("\nCanonical string cannot be confused:");
{
  // The attack: craft a field that looks like a field boundary so one signature validates a
  // different request. Fixed arity + newline joining must make these distinct strings.
  const a = canonicalString({ method: "POST", path: "/a\n/b", hash: "", ts: 1, nonce: "n" });
  const b = canonicalString({ method: "POST", path: "/a", hash: "/b", ts: 1, nonce: "n" });
  ok("a newline inside a field cannot forge another field", a !== b);
  ok("empty body hashes to empty", bodyHash(undefined) === "" && bodyHash("") === "");
  ok("different bodies hash differently", bodyHash("x") !== bodyHash("y"));
  ok("body hash is stable", bodyHash("x") === bodyHash("x"));
}

console.log("\nKey file on disk:");
{
  const id = loadOrCreate("MacBook:proj", "human");
  ok("loadOrCreate returns a usable identity", /^[0-9a-f]{64}$/.test(id.pubkey));
  ok("key file is mode 0600", (statSync(keyPath("MacBook:proj")).mode & 0o777) === 0o600,
     "0" + (statSync(keyPath("MacBook:proj")).mode & 0o777).toString(8));
  ok("keys dir is mode 0700", (statSync(join(dir, "keys")).mode & 0o777) === 0o700,
     "0" + (statSync(join(dir, "keys")).mode & 0o777).toString(8));
  ok("second call returns the SAME identity (no split history)", loadOrCreate("MacBook:proj").pubkey === id.pubkey);
  ok("load() finds it", load("MacBook:proj").pubkey === id.pubkey);
  ok("unknown name loads as null", load("nobody:here") === null);
  ok("a name with path separators cannot escape the keys dir", !keyPath("../../etc/passwd").includes(".."));
  ok("keys signed by a loaded identity verify", verifyRequest({ headers: hdrsFor(id), ...REQ }).ok);
}

console.log("\nThe private key never leaks:");
{
  const id = loadOrCreate("leak:test");
  ok("publicView omits privkey", !("privkey" in publicView(id)));
  ok("publicView keeps pubkey/name/kind", publicView(id).pubkey === id.pubkey && !!publicView(id).name);
  const headers = hdrsFor(id);
  ok("no header carries the private key", !JSON.stringify(headers).includes(id.privkey));
  ok("the signature is not the private key", headers[HDR.sig] !== id.privkey);
}

console.log("\nsigned-fetch:");
{
  const id = loadOrCreate("sf:test");
  const h = signedHeaders(id, "http://127.0.0.1:4477/send?x=1", { method: "POST", body: "{}" });
  ok("produces all four headers", Object.values(HDR).every(k => !!h[k]));
  ok("signs path AND query", verifyRequest({ headers: h, method: "POST", path: "/send?x=1", body: "{}" }).ok);
  ok("origin is NOT signed (proxy-safe)", verifyRequest({
    headers: signedHeaders(id, "https://hub.example.com/send?x=1", { method: "POST", body: "{}" }),
    method: "POST", path: "/send?x=1", body: "{}" }).ok);
  ok("FAIL-OPEN: no identity -> no headers, no throw", Object.keys(signedHeaders(null, "http://x/y", {})).length === 0);
  ok("FAIL-OPEN: broken identity -> no headers, no throw", Object.keys(signedHeaders({ privkey: "zz", pubkey: "zz" }, "http://x/y", {})).length === 0);
  ok("sfetch is callable without an identity", typeof sfetch === "function");
}

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\ntest-identity-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
