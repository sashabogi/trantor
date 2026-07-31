// trantor — cryptographic identity. THE INTERFACE CONTRACT for Phase 0.
//
// Every other Phase 0 package consumes this module; its shapes are frozen. See
// docs/TDD-trantor-platform.md §7.
//
// WHY THIS EXISTS: the hub's /send validated only that `from` was non-empty, and `from` was
// self-asserted — any local process could speak as any identity. On 2026-07-28 that turned a
// delivery feature into unauthenticated remote code execution (removed in 9a0f3ad). Identity was
// also just a string derived from CLI brand + project, so two seats of one brand in a project were
// literally the same bus peer. Both problems have the same fix: an identity is a KEYPAIR, and the
// label is cosmetic.
//
// SCHEME: Ed25519 via node:crypto — in core, so this adds no dependency to a project whose whole
// character is one Node process and a JSON file. Buzz uses secp256k1/Schnorr because Nostr demands
// it; we deliberately did not build on Nostr, so we take the simpler primitive. The tradeoff is
// stated in the TDD: no drop-in Nostr interop. Every primitive is behind this module, so a second
// scheme can be added later without touching a single call site.
import { generateKeyPairSync, createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify, createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const SCHEME = "trantor-v1";
export const INST_SCHEME = "trantor-inst-v1";
export const SKEW_MS = 120_000;          // reject a signature older/newer than this
export const HDR = {
  pubkey: "x-trantor-pubkey",
  sig: "x-trantor-sig",
  ts: "x-trantor-ts",
  nonce: "x-trantor-nonce",
};
// Instance-subkey headers (docs/INSTANCE-KEYS-CONTRACT.md). When present, x-trantor-pubkey above
// carries the INSTANCE pubkey and the request is attributed to the DURABLE identity below, provided
// the endorsement verifies. Absent → plain v1, unchanged.
export const HDR_INST = {
  durable: "x-trantor-durable",
  inst: "x-trantor-inst",
  endorse: "x-trantor-endorse",
  instTs: "x-trantor-inst-ts",
};

const busDir = () => process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus");
const keysDir = () => join(busDir(), "keys");
// A name is cosmetic, but it becomes a filename, so it gets sanitised twice over: dot-runs collapse
// FIRST (so no `..` survives even in principle), then anything outside the safe charset goes. Relying
// on "we stripped the separators" alone would make traversal one regex edit away.
const safe = (s) => String(s).replace(/\.{2,}/g, "_").replace(/[^A-Za-z0-9_.-]/g, "_");
export const keyPath = (name) => join(keysDir(), `${safe(name)}.json`);

// --- raw <-> KeyObject -------------------------------------------------------------------------
// Ed25519 keys are 32 raw bytes. We store and expose them as hex because a pubkey IS the identity
// and needs to be a short, comparable, copy-pasteable string. JWK is the only export format Node
// offers that yields the raw scalar rather than a DER wrapper.
const b64u = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pubFromHex = (hex) =>
  createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(Buffer.from(hex, "hex")) }, format: "jwk" });

export function generate() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pj = publicKey.export({ format: "jwk" });
  const sj = privateKey.export({ format: "jwk" });
  return {
    pubkey: Buffer.from(pj.x, "base64url").toString("hex"),
    privkey: Buffer.from(sj.d, "base64url").toString("hex"),
  };
}

// Rebuild a usable private KeyObject. We keep the public half alongside so the JWK is well-formed —
// deriving it from d alone is not something node:crypto exposes.
function privKeyObject(identity) {
  return createPrivateKey({
    key: {
      kty: "OKP", crv: "Ed25519",
      d: b64u(Buffer.from(identity.privkey, "hex")),
      x: b64u(Buffer.from(identity.pubkey, "hex")),
    },
    format: "jwk",
  });
}

// --- key file ----------------------------------------------------------------------------------
export function load(name) {
  const f = keyPath(name);
  if (!existsSync(f)) return null;
  try {
    const id = JSON.parse(readFileSync(f, "utf8"));
    if (!id?.pubkey || !id?.privkey) return null;
    return id;
  } catch { return null; }
}

// Create-if-missing, safe against two hooks racing at session start: write to a unique temp file,
// rename into place (atomic on the same filesystem), and if we lost the race, use the winner's key.
// Two identities for one name would silently split a session's history in half.
export function loadOrCreate(name, kind = "agent") {
  const existing = load(name);
  if (existing) return existing;
  mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
  try { chmodSync(keysDir(), 0o700); } catch {}
  const { pubkey, privkey } = generate();
  const id = { name: String(name), kind, pubkey, privkey, createdAt: Date.now() };
  const f = keyPath(name);
  const tmp = `${f}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(id), { mode: 0o600 });
    if (existsSync(f)) { return load(f && name) || id; }     // someone beat us between check and write
    renameSync(tmp, f);
    chmodSync(f, 0o600);
    return id;
  } catch {
    return load(name) || id;                                  // lost the race, or unwritable — never throw
  }
}

// What a peer may see. NEVER serialise `privkey` anywhere: not a response, event, card, or log.
export function publicView(identity) {
  return { name: identity.name, kind: identity.kind, pubkey: identity.pubkey, createdAt: identity.createdAt };
}

// --- canonical request -------------------------------------------------------------------------
export function bodyHash(body) {
  if (body === undefined || body === null || body === "") return "";
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return createHash("sha256").update(buf).digest("hex");
}

// Newline-joined, fixed arity, every field constrained to contain no newline — so no field can be
// crafted to look like the start of another and forge a different request from the same signature.
export function canonicalString({ method, path, hash, ts, nonce }) {
  return [SCHEME, String(method).toUpperCase(), String(path), String(hash ?? ""), String(ts), String(nonce)].join("\n");
}

export function signRequest(identity, { method, path, body }) {
  const ts = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const hash = bodyHash(body);
  const msg = Buffer.from(canonicalString({ method, path, hash, ts, nonce }), "utf8");
  const sig = cryptoSign(null, msg, privKeyObject(identity));      // Ed25519 takes a null algorithm
  return {
    [HDR.pubkey]: identity.pubkey,
    [HDR.sig]: sig.toString("base64"),
    [HDR.ts]: String(ts),
    [HDR.nonce]: nonce,
  };
}

// --- session-instance subkeys (docs/INSTANCE-KEYS-CONTRACT.md) ---------------------------------
// A per-session-instance keypair, ENDORSED by the durable identity: the durable key signs
// endorsementString(...), attesting "this instance pubkey speaks as me until it dies". The durable
// key keeps enrollment/grants/attribution; the instance key signs traffic and dies with the
// session. Fixes the handoff-twin identity collision (two lineages, two subkeys, one durable name)
// and gives per-restart credential freshness (the teams login-session model).
export function endorsementString({ durablePubkey, instancePubkey, instanceId, createdAt }) {
  // Same discipline as canonicalString: newline-joined, fixed arity, no field may contain \n.
  return [INST_SCHEME, String(durablePubkey), String(instancePubkey), String(instanceId), String(createdAt)].join("\n");
}

export const instanceKeyPath = (name, instanceId) =>
  join(keysDir(), "instances", `${safe(name)}@${safe(instanceId)}.json`);

// Mint-or-load an endorsed instance identity. Atomic against racing hooks exactly like
// loadOrCreate: two processes of one session (hooks vs MCP would use DIFFERENT instanceIds, but
// T1/T2 hooks share one) must converge on a single keypair for a given (name, instanceId).
export function loadOrCreateInstance(durableIdentity, instanceId) {
  if (!durableIdentity?.privkey || !instanceId) return null;
  const f = instanceKeyPath(durableIdentity.name, instanceId);
  try {
    if (existsSync(f)) {
      const inst = JSON.parse(readFileSync(f, "utf8"));
      if (inst?.pubkey && inst?.privkey && inst?.endorsement) return inst;
    }
  } catch {}
  try {
    mkdirSync(join(keysDir(), "instances"), { recursive: true, mode: 0o700 });
    const { pubkey, privkey } = generate();
    const createdAt = Date.now();
    const msg = Buffer.from(endorsementString({
      durablePubkey: durableIdentity.pubkey, instancePubkey: pubkey, instanceId, createdAt,
    }), "utf8");
    const endorsement = cryptoSign(null, msg, privKeyObject(durableIdentity)).toString("base64");
    const inst = {
      name: durableIdentity.name, instanceId, pubkey, privkey, createdAt, endorsement,
      durablePubkey: durableIdentity.pubkey,
    };
    const tmp = `${f}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(inst), { mode: 0o600 });
    if (existsSync(f)) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return inst; } }
    renameSync(tmp, f);
    chmodSync(f, 0o600);
    return inst;
  } catch { return null; }                                  // unwritable — caller falls back to durable
}

// The extra wire headers an instance identity contributes (alongside the v1 set signed with ITS key).
export function instanceHeaders(inst) {
  if (!inst?.durablePubkey || !inst?.endorsement) return {};
  return {
    [HDR_INST.durable]: inst.durablePubkey,
    [HDR_INST.inst]: inst.instanceId,
    [HDR_INST.endorse]: inst.endorsement,
    [HDR_INST.instTs]: String(inst.createdAt),
  };
}

// Pure endorsement check: did `durablePubkey` really endorse `instancePubkey` for this instanceId?
// Enrollment/grants/supersession stay with the hub, which owns that state.
export function verifyEndorsement({ durablePubkey, instancePubkey, instanceId, createdAt, endorsement }) {
  if (!durablePubkey || !instancePubkey || !instanceId || !createdAt || !endorsement) return false;
  if (!/^[0-9a-f]{64}$/i.test(durablePubkey) || !/^[0-9a-f]{64}$/i.test(instancePubkey)) return false;
  try {
    const msg = Buffer.from(endorsementString({ durablePubkey, instancePubkey, instanceId, createdAt }), "utf8");
    return cryptoVerify(null, msg, pubFromHex(durablePubkey), Buffer.from(endorsement, "base64"));
  } catch { return false; }
}

// Pure verification: signature + freshness only. Replay defence (nonce memory) and authorization
// (is this pubkey known? may it touch this project?) belong to the hub, which owns that state.
// Returns { ok, pubkey, ts, nonce, reason }.
export function verifyRequest({ headers, method, path, body, now = Date.now() }) {
  const get = (k) => (typeof headers?.get === "function" ? headers.get(k) : headers?.[k] ?? headers?.[k.toLowerCase()]);
  const pubkey = get(HDR.pubkey), sig = get(HDR.sig), ts = get(HDR.ts), nonce = get(HDR.nonce);
  if (!pubkey || !sig || !ts || !nonce) return { ok: false, reason: "unsigned" };
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return { ok: false, reason: "bad-pubkey" };
  if (!/^[0-9a-f]{32}$/i.test(nonce)) return { ok: false, reason: "bad-nonce" };
  const t = Number(ts);
  if (!Number.isFinite(t)) return { ok: false, reason: "bad-ts" };
  if (Math.abs(now - t) > SKEW_MS) return { ok: false, reason: "stale" };
  const msg = Buffer.from(canonicalString({ method, path, hash: bodyHash(body), ts: t, nonce }), "utf8");
  let ok = false;
  try { ok = cryptoVerify(null, msg, pubFromHex(pubkey), Buffer.from(sig, "base64")); } catch { ok = false; }
  return ok ? { ok: true, pubkey, ts: t, nonce } : { ok: false, reason: "bad-signature" };
}
