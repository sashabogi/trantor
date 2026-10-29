// trantor — cryptographic identity, THE INTERFACE CONTRACT for Phase 0 (docs/TDD-trantor-platform.md §7).
// An identity is an Ed25519 keypair and the label is cosmetic; every primitive lives behind this module.
import { generateKeyPairSync, createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify, createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, readdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { isTestIdentity } from "./test-identity-names.mjs";
import { asFunction, asString } from "./decode.mjs";

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
export const keysDir = () => join(busDir(), "keys");
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

// --- the keychain layer (#11370) -----------------------------------------------------------------
// The private half moves OFF disk into the macOS Keychain (service below, account = the raw
// identity name); `trantor keys migrate` rewrites the file as a pubkey-only stub. Reads go
// Keychain-first through a per-process cache, with a one-line file fallback when locked/absent.
export const IDENTITY_SERVICE = "trantor-identity";
const SECURITY = "/usr/bin/security";
// A drill points this at a throwaway keychain so the operator's real one is never touched.
const kcArgs = () => process.env.TRANTOR_IDENTITY_KEYCHAIN ? [process.env.TRANTOR_IDENTITY_KEYCHAIN] : [];

// Test seam: drills inject a fake ({ get, set, remove } — get returns the stored string | null and
// may THROW to simulate a locked keychain) so no test needs the real thing.
let injectedKeychain = null;
export function injectIdentityKeychain(fake) {
  injectedKeychain = fake || null;
  processCache.clear();
  warned = false;
}

const keychainUsable = () =>
  !!injectedKeychain ||
  (process.platform === "darwin" && process.env.TRANTOR_NO_KEYCHAIN !== "1" && existsSync(SECURITY));

let warned = false;
function warnOnce(msg) {
  if (warned) return;
  warned = true;
  console.error(`trantor identity: ${msg}`);
}

// Three outcomes matter: a hit, a MISS (never stored — normal before migrate), and UNAVAILABLE
// (locked, headless, pre-wake). Only the last one ever warns.
function keychainGet(account) {
  if (injectedKeychain) {
    try { return { value: injectedKeychain.get(account) || null }; }
    catch { return { error: true }; }
  }
  const r = spawnSync(SECURITY, ["find-generic-password", "-a", account, "-s", IDENTITY_SERVICE, "-w", ...kcArgs()], { encoding: "utf8", timeout: 8000 });
  if (r.status === 0) return { value: String(r.stdout).replace(/\n$/, "") };
  return r.status === 44 ? {} : { error: true };   // 44 = errSecItemNotFound
}

function keychainSet(account, value) {
  if (injectedKeychain) { injectedKeychain.set(account, value); return; }
  // The value travels on stdin in `security -i` syntax, so it never shows in the process table;
  // only the exit code comes back (security echoes the failing line, so stderr is not relayed).
  const quote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const kc = kcArgs();
  const line = `add-generic-password -a ${quote(account)} -s ${quote(IDENTITY_SERVICE)} -U -w ${quote(value)}${kc.length ? ` ${quote(kc[0])}` : ""}\n`;
  const r = spawnSync(SECURITY, ["-i"], { encoding: "utf8", input: line, timeout: 8000 });
  if (r.status !== 0) throw new Error(`keychain write failed for ${account} (security exited ${r.status ?? "signal"})`);
}

// A keychain entry is the whole identity as JSON, so it stays self-sufficient even if the stub
// file is lost. Anything that does not parse to a well-formed Ed25519 pair is not a key.
const HEX64 = /^[0-9a-f]{64}$/i;
function parseStored(raw) {
  try {
    const id = JSON.parse(raw);
    return HEX64.test(id?.pubkey || "") && HEX64.test(id?.privkey || "") ? id : null;
  } catch { return null; }
}

// --- key file ----------------------------------------------------------------------------------
// One read per process: hooks sign often, and the Keychain read is the expensive half.
const processCache = new Map();
const cacheKey = (name) => `${keysDir()}\x00${name}`;
export function load(name) {
  const ck = cacheKey(String(name));
  if (processCache.has(ck)) return processCache.get(ck);
  const id = resolveIdentity(String(name));
  processCache.set(ck, id);
  return id;
}

function resolveIdentity(name) {
  const f = keyPath(name);
  let fileId = null;
  if (existsSync(f)) {
    try {
      const parsed = JSON.parse(readFileSync(f, "utf8"));
      if (parsed?.pubkey) fileId = parsed;
    } catch { fileId = null; }
  }
  // A file still carrying its privkey is the live record: a rotate or a fresh mint lands in the
  // file first, so it must win over any older keychain copy under the same name.
  if (fileId?.privkey) return fileId;
  if (keychainUsable()) {
    const kc = keychainGet(String(name));
    const stored = kc.value ? parseStored(kc.value) : null;
    // The keychain holds a self-consistent pair; the stub contributes display fields only. Taking
    // the stub's pubkey with the keychain's privkey would mint an identity whose signatures never
    // verify — so the crypto pair always comes from the same store.
    if (stored) return fileId ? { ...stored, ...fileId, privkey: stored.privkey, pubkey: stored.pubkey } : stored;
    if (fileId) {
      warnOnce(kc.error
        ? `the Keychain is unavailable (locked?) and "${name}" has no key file to fall back on — signing fails until it unlocks`
        : `"${name}": the key file is a pubkey-only stub but the Keychain has no entry — re-run \`trantor keys migrate\` or restore the key`);
    }
  } else if (fileId) {
    warnOnce(`the Keychain is disabled on this platform and "${name}" has no key file to fall back on — signing fails`);
  }
  return null;
}

// Create-if-missing, safe against two hooks racing at session start: write to a unique temp file,
// rename into place (atomic on the same filesystem), and if we lost the race, use the winner's key.
// Two identities for one name would silently split a session's history in half.
// New keys are born as FILES even when the Keychain is up — `trantor keys migrate` moves them.
export function loadOrCreate(name, kind = "agent") {
  const existing = load(name);
  if (existing) return existing;
  // A record exists (a pubkey-only stub, or a keychain entry the read above could not use) but its
  // private half is unreachable right now: minting a new key would split the history, so refuse.
  if (existsSync(keyPath(name))) return null;
  mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
  try { chmodSync(keysDir(), 0o700); } catch {}
  const { pubkey, privkey } = generate();
  const id = { name: String(name), kind, pubkey, privkey, createdAt: Date.now() };
  const f = keyPath(name);
  const tmp = `${f}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    try {
      writeFileSync(tmp, JSON.stringify(id), { mode: 0o600 });
      if (existsSync(f)) return load(name) || id;             // someone beat us between check and write
      renameSync(tmp, f);
      chmodSync(f, 0o600);
      processCache.set(cacheKey(String(name)), id);
      return id;
    } finally {
      try { unlinkSync(tmp); } catch {}                       // unconditional: no early exit leaves a tmp holding a private key
    }
  } catch {
    return load(name) || id;                                  // lost the race, or unwritable — never throw
  }
}

// What a peer may see. NEVER serialise `privkey` anywhere: not a response, event, card, or log.
export function publicView(identity) {
  return { name: identity.name, kind: identity.kind, pubkey: identity.pubkey, createdAt: identity.createdAt };
}

function loopbackHost(host) {
  return ["localhost", "localhost.", "[::1]"].includes(host) || (isIP(host) === 4 && host.startsWith("127."));
}

export function loopbackHub(base) {
  const url = new URL(base);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return false;
  return loopbackHost(url.hostname);
}

export function phoneHubAddress(base, publicUrl = "", forceTailnet = false) {
  const hub = String(!forceTailnet && publicUrl || base).trim().replace(/\/+$/, "");
  const url = new URL(hub);
  if (!/^https?:$/.test(url.protocol) || loopbackHost(url.hostname) || ["0.0.0.0", "[::]"].includes(url.hostname)) {
    throw new Error(`Your phone cannot reach ${hub}: this address only works on this Mac. Use Tailscale on the Mac and iPhone and configure the hub with the Mac's Tailscale address (then use trantor pair --tailnet), or configure a public hub URL.`);
  }
  return { hub, public: !forceTailnet && !!publicUrl };
}

// The hub's owner-only read verifies a candidate without minting an invite or changing scopes.
export async function resolveOwnerIdentity(base) {
  let config = {};
  try { config = JSON.parse(readFileSync(join(busDir(), "config.json"), "utf8")); } catch {}
  const explicit = process.env.TRANTOR_IDENTITY || process.env.RELAY_OWNER_IDENTITY || config.ownerIdentity;
  const names = explicit ? [explicit] : listKeyNames().flatMap(file => {
    try {
      const record = JSON.parse(readFileSync(join(keysDir(), `${file}.json`), "utf8"));
      return record.kind === "human" && record.name ? [record.name] : [];
    } catch { return []; }
  });
  const request = async (id, path, payload) => {
    const method = payload ? "POST" : "GET";
    const body = payload ? JSON.stringify(payload) : undefined;
    return fetch(`${base.replace(/\/+$/, "")}${path}`, {
      method, body, redirect: "error", headers: { "content-type": "application/json", ...signRequest(id, { method, path, body }) },
      signal: AbortSignal.timeout(8000),
    });
  };
  let unavailable = "";
  for (const name of names) {
    const id = load(name);
    if (!id) {
      unavailable = `The key for "${name}" is unavailable on this Mac. Unlock the identity Keychain or restore this identity's key.`;
      continue;
    }
    const response = await request(id, "/keys/usage");
    if (response.ok) return id;
    if (response.status === 401 && loopbackHub(base)) {
      const error = await response.json();
      if (error.error === "unknown identity") {
        const enrolled = await request(id, "/enroll", { name: id.name, kind: "human" });
        if (enrolled.ok && (await request(id, "/keys/usage")).ok) return id;
      }
    }
  }
  if (!names.length && loopbackHub(base)) {
    const id = loadOrCreate("human", "human");
    if (!id) throw new Error("The local human identity exists, but its key is unavailable. Unlock the identity Keychain or restore its key.");
    const enrolled = await request(id, "/enroll", { name: id.name, kind: "human" });
    if (enrolled.ok && (await request(id, "/keys/usage")).ok) return id;
    throw new Error("The local hub refused owner enrollment. Ask its owner for an invite or configure the existing owner identity.");
  }
  throw new Error(unavailable || `No local owner identity is authorized on ${base}. Enroll this Mac with an owner invite, or select its existing owner key with TRANTOR_IDENTITY.`);
}

// --- migrate + status (`trantor keys …`) ---------------------------------------------------------
// One <safe-name>.json per durable identity; the instances/ subdir holds per-session subkeys that
// die with the session and stay files by design.
export function listKeyNames() {
  let files = [];
  try { files = readdirSync(keysDir()); } catch { return []; }
  return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort();
}

// The stub keeps everything a peer may see plus a pointer at where the private half now lives.
function writeKeyStub(f, id) {
  const stub = { name: id.name, kind: id.kind, pubkey: id.pubkey, createdAt: id.createdAt, keychain: IDENTITY_SERVICE };
  const tmp = `${f}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(stub), { mode: 0o600 });
    renameSync(tmp, f);
  } finally {
    try { unlinkSync(tmp); } catch {}                         // a failed rename must not strand its tmp
  }
  try { chmodSync(f, 0o600); } catch {}
}

// Copy each file-held private key into the Keychain, prove the stored copy SIGNS (a round-trip
// against the file's pubkey), and only then rewrite the file as a pubkey-only stub. A key that
// fails to store or to verify keeps its file untouched.
export function migrateKeysToKeychain({ dryRun = false, names = [], includeTests = false } = {}) {
  const result = { service: IDENTITY_SERVICE, usable: keychainUsable(), moved: [], already: [], failed: [], skippedTests: 0, dryRun };
  if (!result.usable && !dryRun) return result;
  const requested = new Set(names);
  const found = new Set();
  for (const fileBase of listKeyNames()) {
    let id = null;
    try { id = JSON.parse(readFileSync(keyPath(fileBase), "utf8")); } catch {}
    // The keychain account is the IDENTITY's name (card #11370), i.e. the raw name the JSON
    // carries — the file's name is only the sanitised lookup key and load() reads back by the
    // raw name, so storing under "name_proj" while hooks look for "name:proj" would orphan
    // every migrated key on its first read.
    const name = id?.name ?? fileBase;
    if (requested.size && !requested.has(name)) continue;
    found.add(name);
    if (!requested.size && !includeTests && isTestIdentity(name)) {
      result.skippedTests++;
      continue;
    }
    if (!id?.pubkey) { result.failed.push({ name, reason: "unreadable key file" }); continue; }
    if (!id.privkey) { result.already.push(name); continue; }
    if (dryRun) { result.moved.push(name); continue; }
    try {
      keychainSet(name, JSON.stringify(id));
      const stored = parseStored(keychainGet(name).value || "");
      if (!stored || stored.privkey !== id.privkey || stored.pubkey !== id.pubkey) throw new Error("read-back mismatch");
      const probe = Buffer.from(`trantor-keychain-migrate\n${id.pubkey}`, "utf8");
      const sig = cryptoSign(null, probe, privKeyObject(stored));
      if (!cryptoVerify(null, probe, pubFromHex(id.pubkey), sig)) throw new Error("signature round-trip failed");
      writeKeyStub(keyPath(name), id);
      processCache.clear();                    // this process now reads stub + keychain
      result.moved.push(name);
    } catch (e) {
      result.failed.push({ name, reason: String(e?.message || e) });
    }
  }
  for (const name of requested) {
    if (!found.has(name)) result.failed.push({ name, reason: "identity not found" });
  }
  return result;
}

// Where does each identity's PRIVATE half live? Presence booleans only — key material is never
// read into the report.
export function keyLocationReport() {
  const usable = keychainUsable();
  const names = listKeyNames();
  const probeKeychain = usable && names.length <= 50;
  return names.map((fileBase) => {
    let fileKey = false, pubkey = null, name = fileBase;
    try {
      const id = JSON.parse(readFileSync(keyPath(fileBase), "utf8"));
      fileKey = !!id?.privkey;
      pubkey = id?.pubkey || null;
      name = id?.name ?? fileBase;               // the identity's real name is what the keychain is keyed on
    } catch {}
    const inKeychain = probeKeychain ? !!parseStored(keychainGet(name).value || "") : usable ? null : false;
    const where = fileKey && inKeychain ? "file + keychain" : fileKey ? "file (plaintext)" : inKeychain ? "keychain" : inKeychain === null ? "keychain not checked (more than 50 identities)" : "NO USABLE PRIVATE KEY";
    return { name, pubkey, where, keychain: inKeychain, fileKey };
  });
}

// --- canonical request -------------------------------------------------------------------------
export function bodyHash(body) {
  if (body === undefined || body === null || body === "") return "";
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(asString(body) ?? JSON.stringify(body), "utf8");
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
// A per-instance keypair endorsed by the durable identity: the durable key keeps enrollment and
// attribution, the instance key signs traffic and dies with the session (handoff-twin fix).
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
    try {
      writeFileSync(tmp, JSON.stringify(inst), { mode: 0o600 });
      if (existsSync(f)) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return inst; } }
      renameSync(tmp, f);
      chmodSync(f, 0o600);
      return inst;
    } finally {
      try { unlinkSync(tmp); } catch {}                       // the race loser's tmp still holds a private key — never strand it
    }
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
  const lookup = asFunction(headers?.get);
  const get = (k) => (lookup ? lookup.call(headers, k) : headers?.[k] ?? headers?.[k.toLowerCase()]);
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
