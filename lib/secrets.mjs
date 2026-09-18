// trantor — the secret store (#6393). Provider keys live in the OS keychain; ~/.agent-bus/.env is
// the fallback layer and a names-only manifest says what moved. A value never reaches argv, a log
// line or stdout: set goes through `security -i` on stdin, get is captured in-process.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { busDirFor } from "./project.mjs";

export const SERVICE = "trantor";
export const SECRET_NAME = /(?:_API_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD)$/;
export const SHADOW_PREFIX = "__TRANTOR_SECRET__";
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ENV_LINE = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/;
const STUB_LINE = /^#\s*([A-Z][A-Z0-9_]*)\s*->\s*keychain\b/;
const SECURITY = "/usr/bin/security";

export const isSecretName = (name) => ENV_NAME.test(name) && SECRET_NAME.test(name);
export const stubLine = (name) => `# ${name} -> keychain (trantor secrets list)`;
export const manifestPath = (env = process.env) => join(busDirFor(env), "secrets.json");
export const envFilePath = (env = process.env) => join(busDirFor(env), ".env");
const fileStorePath = (env) => join(busDirFor(env), "secrets.file.json");

// keychain | file | none. Explicit env wins; the keychain is the default on darwin only once the
// manifest exists (or a writer asks to create it), so a fake-HOME drill never touches the real one.
export function backendFor(env = process.env, { create = false } = {}) {
  if (env.TRANTOR_NO_KEYCHAIN === "1") return "none";
  const asked = env.TRANTOR_SECRETS_BACKEND;
  if (asked === "keychain" || asked === "file" || asked === "none") return asked;
  if (process.platform !== "darwin") return "none";
  return create || existsSync(manifestPath(env)) ? "keychain" : "none";
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function writePrivate(file, text) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* a foreign filesystem without modes still holds the file */ }
}

function readManifest(env) {
  const m = readJson(manifestPath(env), null);
  return m && m.names ? m : { version: 1, names: {} };
}

function writeManifest(env, manifest) {
  writePrivate(manifestPath(env), JSON.stringify(manifest, null, 2) + "\n");
}

function assertName(name) {
  if (!ENV_NAME.test(String(name || ""))) throw new Error(`not an env-style secret name: ${JSON.stringify(String(name))}`);
}

// The value travels on stdin in `security -i` command syntax, so it is never an argv the process
// table can show. Only the exit code comes back: security echoes the failing line, so its stderr
// is never relayed either.
const quote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
function keychainBackend(env) {
  const kc = env.TRANTOR_SECRETS_KEYCHAIN || "";
  const tail = kc ? [kc] : [];
  const run = (args, input) => spawnSync(SECURITY, args, { encoding: "utf8", input, timeout: 8000, stdio: ["pipe", "pipe", "pipe"] });
  return {
    get(name) {
      const r = run(["find-generic-password", "-a", name, "-s", SERVICE, "-w", ...tail]);
      return r.status === 0 ? String(r.stdout).replace(/\n$/, "") : null;
    },
    set(name, value) {
      const line = `add-generic-password -a ${quote(name)} -s ${quote(SERVICE)} -U -w ${quote(value)}${kc ? ` ${quote(kc)}` : ""}\n`;
      const r = run(["-i"], line);
      if (r.status !== 0) throw new Error(`keychain write failed for ${name} (security exited ${r.status ?? "signal"})`);
    },
    remove(name) {
      const r = run(["delete-generic-password", "-a", name, "-s", SERVICE, ...tail]);
      if (r.status !== 0 && r.status !== 44) throw new Error(`keychain delete failed for ${name} (security exited ${r.status ?? "signal"})`);
    },
  };
}

// The portable backend: one mode-600 JSON file. It is what a drill selects, and what a platform
// without a keychain can opt into; it is never the default.
function fileBackend(env) {
  const file = fileStorePath(env);
  const load = () => readJson(file, {});
  const save = (all) => writePrivate(file, JSON.stringify(all, null, 2) + "\n");
  return {
    get(name) { const all = load(); return name in all ? String(all[name]) : null; },
    set(name, value) { const all = load(); all[name] = value; save(all); },
    remove(name) { const all = load(); delete all[name]; save(all); },
  };
}

const noneBackend = () => ({
  get() { return null; },
  set(name) { throw new Error(`no secret store on this platform for ${name} (TRANTOR_SECRETS_BACKEND=file opts into the file store)`); },
  remove() { /* nothing is stored, so nothing is removed */ },
});

export function openStore(env = process.env, { create = false } = {}) {
  const backend = backendFor(env, { create });
  const impl = backend === "keychain" ? keychainBackend(env) : backend === "file" ? fileBackend(env) : noneBackend();
  const names = () => Object.keys(readManifest(env).names).sort();
  return {
    backend,
    names,
    has: (name) => names().includes(name),
    get(name) {
      assertName(name);
      return backend === "none" ? null : impl.get(name);
    },
    set(name, value) {
      assertName(name);
      if (!String(value)) throw new Error(`refusing to store an empty value for ${name}`);
      impl.set(name, String(value));
      const manifest = readManifest(env);
      manifest.names[name] = { movedAt: new Date().toISOString() };
      writeManifest(env, manifest);
    },
    remove(name) {
      assertName(name);
      impl.remove(name);
      const manifest = readManifest(env);
      if (!(name in manifest.names)) return false;
      delete manifest.names[name];
      writeManifest(env, manifest);
      return true;
    },
    values() {
      const out = {};
      if (backend === "none") return out;
      for (const name of names()) {
        const v = impl.get(name);
        if (v) out[name] = v;
      }
      return out;
    },
  };
}

// The store as an env layer: {} when there is no store, so every reader can spread it blindly.
export function resolveSecrets(env = process.env) {
  try { return openStore(env).values(); } catch { return {}; }
}

// What ~/.agent-bus/.env still says: live secret lines (a value on disk), stub lines, and the
// non-secret lines that stay there on purpose (flags).
export function envFileSecrets(env = process.env) {
  const out = { file: envFilePath(env), live: [], stubbed: [], kept: [] };
  let text = "";
  try { text = readFileSync(out.file, "utf8"); } catch { return out; }
  for (const raw of text.split("\n")) {
    const stub = STUB_LINE.exec(raw.trim());
    if (stub) { out.stubbed.push(stub[1]); continue; }
    const m = ENV_LINE.exec(raw.trim());
    if (!m) continue;
    if (!isSecretName(m[1])) { out.kept.push(m[1]); continue; }
    (m[2].trim() ? out.live : out.stubbed).push(m[1]);
  }
  return out;
}

const unquote = (v) => ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) ? v.slice(1, -1) : v;

// Rewrite the live lines for `names` as stubs. Returns the names that were actually live.
function stubEnvLines(env, names, { dryRun = false } = {}) {
  const file = envFilePath(env);
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  const wanted = new Set(names);
  const stubbed = [];
  const lines = text.split("\n").map((raw) => {
    const m = ENV_LINE.exec(raw.trim());
    if (!m || !wanted.has(m[1])) return raw;
    stubbed.push(m[1]);
    return stubLine(m[1]);
  });
  if (stubbed.length && !dryRun) writePrivate(file, lines.join("\n"));
  return stubbed;
}

// One write path for a key: the store takes the value, and a live line for the same name in
// .env becomes a stub so the file can never shadow the store.
export function putSecret(name, value, env = process.env) {
  const store = openStore(env, { create: true });
  store.set(name, value);
  return { backend: store.backend, stubbed: stubEnvLines(env, [name]).length > 0 };
}

export function dropSecret(name, env = process.env) {
  const store = openStore(env);
  return { backend: store.backend, removed: store.remove(name) };
}

// `trantor secrets migrate`: every live secret line moves into the store and becomes a stub; an
// empty secret line becomes a stub too (an empty export shadows the store). Stubs are skipped, so
// a second run changes nothing.
export function migrateSecrets(env = process.env, { dryRun = false } = {}) {
  const before = envFileSecrets(env);
  const result = { backend: backendFor(env, { create: true }), file: before.file, moved: [], cleared: [], stubbed: before.stubbed, kept: before.kept, dryRun };
  if (!existsSync(before.file)) return result;
  const text = readFileSync(before.file, "utf8");
  const store = dryRun ? null : openStore(env, { create: true });
  const lines = text.split("\n").map((raw) => {
    const m = ENV_LINE.exec(raw.trim());
    if (!m || !isSecretName(m[1])) return raw;
    const value = unquote(m[2].trim());
    if (!value) { result.cleared.push(m[1]); return stubLine(m[1]); }
    if (store) store.set(m[1], value);
    result.moved.push(m[1]);
    return stubLine(m[1]);
  });
  if (!dryRun && (result.moved.length || result.cleared.length)) writePrivate(before.file, lines.join("\n"));
  if (!dryRun && store) result.backend = store.backend;
  return result;
}

// Injection for a spawned seat: values ride the spawn env under shadow names and the shell
// re-exports them AFTER the .env sources ran, so the store wins over any stale file line.
export function shadowEnv(values) {
  const out = {};
  for (const [name, value] of Object.entries(values)) out[`${SHADOW_PREFIX}${name}`] = value;
  return out;
}

export function withSecretExports(cmd, names) {
  const exports = names.filter((n) => ENV_NAME.test(n))
    .map((n) => `export ${n}="$${SHADOW_PREFIX}${n}"; unset ${SHADOW_PREFIX}${n};`);
  return exports.length ? `${exports.join(" ")} ${cmd}` : cmd;
}
