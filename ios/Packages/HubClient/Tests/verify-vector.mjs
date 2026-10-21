// Cross-check for the iOS signer: the hub's real verifier must accept what Swift signed.
// Fixture: HubClientTests/Fixtures/signing-vector.json, written by SignerTests
// (regenerate with: TRANTOR_WRITE_VECTOR=1 swift test). Run: node verify-vector.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { verifyRequest, canonicalString, bodyHash, HDR, SCHEME } from "../../../../lib/identity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(readFileSync(join(here, "HubClientTests/Fixtures/signing-vector.json"), "utf8"));

// 1. The message and hash Swift built are the ones the hub builds from the same inputs.
assert.equal(SCHEME, "trantor-v1");
assert.equal(bodyHash(v.body), v.bodyHash, "body hash differs");
const msg = canonicalString({ method: v.method, path: v.path, hash: bodyHash(v.body), ts: v.ts, nonce: v.headers[HDR.nonce] });
assert.equal(msg, v.message, "canonical string differs");

// 2. The real verifier accepts the Swift signature. `now` is pinned to the vector's ts: the hub
//    rejects skew over 120 s, so a fixed vector can only pass at its own time.
const ok = verifyRequest({ headers: v.headers, method: v.method, path: v.path, body: v.body, now: v.ts });
assert.equal(ok.ok, true, `hub rejected the Swift signature: ${ok.reason}`);
assert.equal(ok.pubkey, v.headers[HDR.pubkey]);
console.log(`ok  verifyRequest accepted Swift signature (pubkey ${ok.pubkey.slice(0, 16)}..., ts ${ok.ts}, nonce ${ok.nonce})`);

// 3. Negative controls: tampering with any signed field must be rejected.
const tamper = (patch) => verifyRequest({ headers: v.headers, method: v.method, path: v.path, body: v.body, now: v.ts, ...patch });
assert.equal(tamper({ body: '{"id":2}' }).reason, "bad-signature");
assert.equal(tamper({ path: "/task/update?x=2" }).reason, "bad-signature");
assert.equal(tamper({ method: "GET" }).reason, "bad-signature");
assert.equal(tamper({ now: v.ts + 121_000 }).reason, "stale");
console.log("ok  tampered body, path, method and stale clock are all rejected");
