// trantor provider registry — ONE truth for "is this provider ready to seat?" (#6390), built the
// way Orca does onboarding (stablyai/orca: src/main/providers + src/main/claude-accounts): a
// registry per agent with a PATH detect (`command -v`), the CLI's own login command, the CLI's own
// credential artifact, and "connected" = a LIVE usage call succeeded — never "file exists".
// Consumers: `trantor provider status [--json]`, `trantor provider verify` (pre-save key check),
// the desktop provider_status/provider_verify Tauri commands (they shell the CLI — one renderer),
// and `trantor doctor`. The JSON row shape is FROZEN (the Accounts pane #6391 and wizard #6392
// build against it):
//   [{ provider, label, kind, connect, binary:{name,installed,path}, auth:{artifact,present,mode},
//      state, reason, usage:{...balances row}, actions:["login"|"paste-key"|"recheck"|"remove"] }]
// state ∈ connected | not_installed | not_logged_in | expired | over_quota | unknown — ALWAYS with
// a non-empty reason. The kimi row that used to render a blank "plan" in the bar is the bug this
// fixes: no row exists without a state and a reason.
//
// PROBES ARE NOT DUPLICATED: every live check is lib/balances.mjs — the ADAPTERS (kimi/zai/qwen/
// deepseek/openrouter/moonshot/claude) plus fetchBalances' codex block. This module only decides
// WHAT to ask and maps the answer to a state.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { fetchBalances, fmtBalance, fmtReset } from "./balances.mjs";
import { resolveKeys } from "./provider-keys.mjs";

export const STATES = ["connected", "not_installed", "not_logged_in", "expired", "over_quota", "unknown"];
export const ACTIONS = ["login", "paste-key", "recheck", "remove"];

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const envKeyName = (p) => `${String(p).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;

// Orca's detectCmd: a PATH probe, aliases included, first hit wins. Injectable PATH keeps the
// drills hermetic (opts.path) — a fake bin dir can make `kimi` exist without the real CLI.
// The shell itself is /bin/sh ABSOLUTE: a relative "sh" would be resolved through the very PATH
// we are overriding, and a drill PATH without /bin would read as "no CLIs installed".
function detectBinary(names, opts = {}) {
  const path = opts.path || process.env.PATH;
  for (const n of names.filter(Boolean)) {
    try {
      const p = execFileSync("/bin/sh", ["-c", `command -v ${n}`], { encoding: "utf8", env: { ...process.env, PATH: path } }).trim();
      if (p) return { name: n, installed: true, path: p };
    } catch { /* not on PATH — try the next alias */ }
  }
  return { name: names[0] || null, installed: false, path: null };
}

// The opencode.json provider block key, decoded once at this boundary: a LITERAL key comes back
// as `literal` (feedable to a probe), the "{env:VAR}" template comes back as `template` (the seat
// resolves it at run time, so only the env decides presence here).
function opencodeKey(home, provider) {
  const cfg = readJson(join(home, ".config", "opencode", "opencode.json"));
  const v = cfg?.provider?.[provider]?.options?.apiKey;
  // SAFETY: v is the opencode.json apiKey field decoded by JSON.parse above; the check separates
  // "a string key" (literal, or the {env:VAR} template) from "any other shape" (ignored — a
  // non-string is never fed to a probe).
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (!v || typeof v !== "string") return { literal: null, template: null };
  const m = /^\{env:([A-Z0-9_]+)\}$/.exec(v);
  return m ? { literal: null, template: m[1] } : { literal: v, template: null };
}

// Claude Code keeps its OAuth token in ~/.claude/.credentials.json (or $CLAUDE_CONFIG_DIR),
// then the macOS keychain item "Claude Code-credentials". Attribute-only keychain lookup (no -w,
// doctor's rule): a health read must never raise a GUI secret prompt. The keychain is tried ONLY
// when the caller did not inject a home (ctx.allowKeychain) — drills stay hermetic and never
// touch the operator's real secrets.
function claudeAuth(home, env, ctx = {}) {
  const dirs = [];
  const cfgDir = env.CLAUDE_CONFIG_DIR;
  if (cfgDir) dirs.push(isAbsolute(cfgDir) ? cfgDir : join(home, cfgDir));
  dirs.push(join(home, ".claude"));
  for (const dir of dirs) {
    const j = readJson(join(dir, ".credentials.json"));
    const tok = j?.claudeAiOauth;
    if (tok?.accessToken) {
      const exp = Date.parse(tok.expiresAt);
      return { artifact: `${dir.replace(home, "~")}/.credentials.json`, present: true, mode: "oauth", expiresAt: Number.isFinite(exp) ? exp : null };
    }
  }
  // The keychain is skipped when the caller injected a home (drill) or set TRANTOR_NO_KEYCHAIN=1
  // (CLI drill: fake $HOME isolates the FILES, but the login keychain is machine-wide — a drill
  // must never read, or even attribute-probe, the operator's real secrets).
  if (ctx.allowKeychain && ctx.env.TRANTOR_NO_KEYCHAIN !== "1" && process.platform === "darwin") {
    try {
      execFileSync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials"], { stdio: "ignore", timeout: 4000 });
      return { artifact: "keychain: Claude Code-credentials", present: true, mode: "oauth", expiresAt: null };
    } catch { /* no keychain item → fall through to absent */ }
  }
  return { artifact: "~/.claude/.credentials.json", present: false, mode: null, expiresAt: null };
}

// Codex auth.json modes (Orca): tokens present → "chatgpt" (OAuth); OPENAI_API_KEY → "apikey".
// The id_token's `email` claim names the account — reason text only, tokens never leave here.
function codexAuth(home) {
  const j = readJson(join(home, ".codex", "auth.json"));
  if (j?.tokens?.access_token) {
    let email = null;
    try {
      const payload = JSON.parse(Buffer.from(String(j.tokens.id_token || "").split(".")[1] || "", "base64url").toString("utf8"));
      email = payload?.email || null;
    } catch { /* a malformed id_token costs the reason its email, never the row */ }
    return { artifact: "~/.codex/auth.json", present: true, mode: "chatgpt", email };
  }
  if (j?.OPENAI_API_KEY) return { artifact: "~/.codex/auth.json", present: true, mode: "apikey", email: null };
  return { artifact: "~/.codex/auth.json", present: false, mode: null, email: null };
}

// api-key providers: env first (the layered resolveKeys the crew itself uses), then a LITERAL key
// wired into opencode.json. A "{env:VAR}" template defers to the env by design.
function apiKeyAuth(home, env, { envKeys, ocProvider, artifact }) {
  for (const k of envKeys) {
    if (env[k]) return { artifact: `env ${k}`, present: true, mode: "api-key", key: env[k], expiresAt: null };
  }
  if (ocProvider) {
    const oc = opencodeKey(home, ocProvider);
    if (oc.literal) return { artifact: "~/.config/opencode/opencode.json", present: true, mode: "api-key", key: oc.literal, expiresAt: null };
    if (oc.template && env[oc.template]) return { artifact: `env ${oc.template}`, present: true, mode: "api-key", key: env[oc.template], expiresAt: null };
  }
  return { artifact, present: false, mode: null, key: null, expiresAt: null };
}

const fileAuth = (home, file, mode = "oauth") => {
  const rel = file.replace(home, "~");
  return existsSync(file)
    ? { artifact: rel, present: true, mode, key: null, expiresAt: null }
    : { artifact: rel, present: false, mode: null, key: null, expiresAt: null };
};

// PROBE_VIA: providers whose live check rides ANOTHER adapter — dsh bills through DeepSeek's API,
// so its probe IS the deepseek adapter (rebranded on the way out). agy has no balances adapter.
const PROBE_VIA = { dsh: "deepseek" };

export const PROVIDERS = [
  { provider: "claude", label: "Claude", kind: "windows", connect: "cli-login",
    binary: ["claude"], loginCmd: "claude", envKeys: [], probe: "balances",
    auth: claudeAuth,
    hint: "sign in with your Anthropic account on first run" },
  { provider: "codex", label: "Codex", kind: "windows", connect: "cli-login",
    binary: ["codex"], loginCmd: "codex login", envKeys: [], probe: "balances",
    auth: (home) => codexAuth(home),
    hint: "sign in with your ChatGPT account" },
  { provider: "kimi", label: "Kimi Code", kind: "quota", connect: "cli-login",
    binary: ["kimi"], loginCmd: "kimi (then /login)", envKeys: ["KIMI_API_KEY"], probe: "balances",
    auth: (home, env) => (env.KIMI_API_KEY
      ? { artifact: "env KIMI_API_KEY", present: true, mode: "api-key", key: env.KIMI_API_KEY, expiresAt: null }
      : fileAuth(home, join(home, ".kimi", "credentials"))),
    hint: "Kimi account or Moonshot API key" },
  { provider: "zai", label: "Z.ai (GLM)", kind: "quota", connect: "api-key",
    binary: ["opencode"], loginCmd: "trantor provider add zai --key …", envKeys: ["ZAI_API_KEY", "GLM_API_KEY"], probe: "balances",
    auth: (home, env) => apiKeyAuth(home, env, { envKeys: ["ZAI_API_KEY", "GLM_API_KEY"], ocProvider: "zai-coding-plan", artifact: "env ZAI_API_KEY" }),
    hint: "get a coding-plan key at z.ai, then trantor provider add zai --key …" },
  { provider: "qwen", label: "Qwen", kind: "quota", connect: "cli-login",
    binary: ["qwen"], loginCmd: "qwen", envKeys: ["QWEN_API_KEY"], probe: "balances",
    auth: (home, env) => (env.QWEN_API_KEY
      ? { artifact: "env QWEN_API_KEY", present: true, mode: "api-key", key: env.QWEN_API_KEY, expiresAt: null }
      : fileAuth(home, join(home, ".qwen", "oauth_creds.json"))),
    hint: "run qwen once — its OAuth flow opens on first start" },
  { provider: "deepseek", label: "DeepSeek", kind: "prepaid", connect: "api-key",
    binary: ["opencode"], loginCmd: "trantor provider add deepseek --key …", envKeys: ["DEEPSEEK_API_KEY"], probe: "balances",
    auth: (home, env) => apiKeyAuth(home, env, { envKeys: ["DEEPSEEK_API_KEY"], ocProvider: "deepseek", artifact: "env DEEPSEEK_API_KEY" }),
    hint: "get a key at platform.deepseek.com, then trantor provider add deepseek --key …" },
  { provider: "openrouter", label: "OpenRouter", kind: "prepaid", connect: "api-key",
    binary: ["opencode"], loginCmd: "trantor provider add openrouter --key …", envKeys: ["OPENROUTER_API_KEY"], probe: "balances",
    auth: (home, env) => apiKeyAuth(home, env, { envKeys: ["OPENROUTER_API_KEY"], ocProvider: "openrouter", artifact: "env OPENROUTER_API_KEY" }),
    hint: "get a key at openrouter.ai/keys — one key fronts hundreds of models" },
  { provider: "moonshot", label: "Moonshot", kind: "prepaid", connect: "api-key",
    binary: [], loginCmd: "trantor provider add moonshot --key …", envKeys: ["MOONSHOT_API_KEY"], probe: "balances",
    auth: (home, env) => apiKeyAuth(home, env, { envKeys: ["MOONSHOT_API_KEY"], ocProvider: null, artifact: "env MOONSHOT_API_KEY" }),
    hint: "Moonshot platform key (api.moonshot.ai) — distinct from the Kimi Code login" },
  { provider: "agy", label: "Antigravity (agy)", kind: "unknown", connect: "cli-login",
    binary: ["agy"], loginCmd: "agy", envKeys: [], probe: null,
    auth: () => ({ artifact: null, present: false, mode: null, key: null, expiresAt: null }),
    hint: "Antigravity CLI — Google sign-in on first run" },
  { provider: "dsh", label: "DeepSeek Harness", kind: "prepaid", connect: "api-key",
    binary: ["dsh"], loginCmd: "npm i -g @deepseek-ai/dsh && trantor connect", envKeys: ["DEEPSEEK_API_KEY"], probe: "balances",
    auth: (home, env) => apiKeyAuth(home, env, { envKeys: ["DEEPSEEK_API_KEY"], ocProvider: null, artifact: "env DEEPSEEK_API_KEY" }),
    hint: "API-billed via DEEPSEEK_API_KEY — the same key the deepseek seat uses" },
];

const REG = Object.fromEntries(PROVIDERS.map((p) => [p.provider, p]));

// The probe, for real: lib/balances.mjs IS the probe surface (card rule — reuse, never duplicate).
// `only: [via]` hits exactly one adapter; dsh's row is rebranded on the way out so usage stays a
// true balances row under the dsh provider name. `fetch` is the drill seam — tests hand a stub
// instead of the real fetchBalances, no module mocking involved.
async function balancesProbe(name, env, fetch = fetchBalances) {
  const via = PROBE_VIA[name] || name;
  const rows = await fetch(env, { only: [via] });
  const row = (rows || []).find((r) => r.provider === via);
  if (!row) return null;
  return via === name ? row : { ...row, provider: name, label: REG[name].label };
}
// Named export for drills: the rebrand/via mapping is part of the probe contract (dsh rides the
// deepseek adapter), and the drill asserts it with a stubbed `fetch`, never the real network.
export { balancesProbe as balancesProbeForDrills };

// Reason from a healthy balances row: the detail line when the adapter wrote one (qwen's
// console-only note, kimi's window line), else fmtBalance's text minus the "Label: " prefix.
// This is the kimi fix: `remainingPct: null` no longer blanks the row — the detail IS the reason.
function reasonFromUsage(row) {
  if (row.detail) return row.detail;
  const s = fmtBalance(row);
  const at = s.indexOf(": ");
  return at > -1 ? s.slice(at + 2) : s;
}

const shortError = (e) => String(e ?? "unknown error").slice(0, 160);

// Probe outcome → (state, reason). Orca's rule: a live authenticated call that ANSWERED is
// connected, whatever the numbers; the exceptions are explicit.
function stateFromProbe(p, row) {
  if (!row) {
    return { state: "unknown", reason: "live probe returned nothing — the provider is not configured for probing" };
  }
  if (!row.ok) {
    const err = shortError(row.error);
    if (/429|insufficient_quota|quota exceeded/i.test(err)) {
      return { state: "over_quota", reason: `provider reports quota exhausted — ${err}` };
    }
    if (/401|403|invalid|unauthorized|rejected|expired/i.test(err)) {
      return p.connect === "cli-login"
        ? { state: "expired", reason: `login token rejected (${err}) — run: ${p.loginCmd}` }
        : { state: "not_logged_in", reason: `API key rejected (${err}) — paste a fresh key` };
    }
    if (/no .*token|credentials/i.test(err)) {
      return { state: "not_logged_in", reason: `no usable credential (${err}) — run: ${p.loginCmd}` };
    }
    return { state: "unknown", reason: `live probe failed — ${err}` };
  }
  // A spent quota plan ANSWERS ok with 0% left (qwen's wall: ok:true, remainingPct: 0).
  if (row.kind === "quota" && row.remainingPct === 0) {
    const reset = row.resetTime ? ` · resets ${fmtReset(row.resetTime)}` : "";
    return { state: "over_quota", reason: `${row.detail || "quota spent"}${reset}` };
  }
  const who = row.plan ? `${row.plan} — ` : "";
  return { state: "connected", reason: `${who}${reasonFromUsage(row)}` };
}

// actions are derived, never stored, so they can never contradict the state.
function actionsFor(p, state) {
  const base = ["recheck"];
  if (state !== "not_installed") base.push("remove");
  if (state === "not_logged_in" || state === "expired") base.unshift(p.connect === "cli-login" ? "login" : "paste-key");
  else if (state === "not_installed" && p.connect === "api-key") base.unshift("paste-key");
  return ACTIONS.filter((a) => base.includes(a));
}

function row(p, { binary, auth, state, reason, usage }) {
  return {
    provider: p.provider, label: p.label, kind: p.kind, connect: p.connect,
    binary, auth: { artifact: auth.artifact, present: !!auth.present, mode: auth.mode },
    state, reason: reason || state,   // never a blank reason — the kimi-bar rule, enforced at the seam
    usage: usage || { ok: false, error: `not probed — ${state}` },
    actions: actionsFor(p, state),
  };
}

async function buildRow(p, ctx) {
  const binary = detectBinary(p.binary, ctx);
  const auth = p.auth(ctx.home, ctx.env, ctx);
  // 1) an explicitly-expired artifact is decided WITHOUT a network round trip.
  if (auth.present && Number.isFinite(auth.expiresAt) && auth.expiresAt < ctx.now) {
    return row(p, { binary, auth, state: "expired",
      reason: `credential expired ${new Date(auth.expiresAt).toISOString().slice(0, 10)} — run: ${p.loginCmd}` });
  }
  // 2) no auth AND no binary → nothing to seat and nothing to probe: not_installed. But a
  //    provider WITH a credential (an env key on a machine without the CLI, qwen's API key on
  //    an opencode-only machine) still gets its LIVE check: the account state is what the bar,
  //    the pane and the wizard act on, and binary.installed is its own contract field.
  if (!auth.present && !binary.installed && p.binary.length) {
    const what = p.connect === "cli-login" ? `${binary.name} CLI not found on PATH` : `${binary.name} not found on PATH — the seat needs it`;
    return row(p, { binary, auth, state: "not_installed", reason: `${what} — install it first (run: ${p.loginCmd})` });
  }
  // 3) no auth at a KNOWN location → not_logged_in, naming the artifact and the fix. The probe
  //    would only echo this back with a slower error, so it is skipped, not trusted. But a
  //    provider whose artifact we cannot read (agy: no reader exists) can never claim this
  //    honestly — "ran once, invisible to us" would read the same as "never ran" — so with no
  //    artifact AND no probe the row is unknown, with the how-to-check in the reason.
  if (!auth.present && auth.artifact) {
    return row(p, { binary, auth, state: "not_logged_in",
      reason: `no credential at ${auth.artifact} — run: ${p.loginCmd}` });
  }
  if (!auth.present && !p.probe) {
    return row(p, { binary, auth, state: "unknown",
      reason: `installed, no credential reader and no live probe — run ${p.binary[0]} once to log in, then recheck` });
  }
  // 4) the live check. probe === null means no balances adapter exists (agy): say unknown and
  //    how to check, rather than reading "binary exists" as connected (Orca's rule).
  if (!p.probe) {
    return row(p, { binary, auth, state: "unknown",
      reason: `installed, no live probe wired — run ${p.binary[0]} once to confirm the login, then recheck` });
  }
  const probeEnv = auth.key && p.envKeys[0] ? { ...ctx.env, [p.envKeys[0]]: auth.key } : ctx.env;
  try {
    const usage = await ctx.probe(p.provider, probeEnv);
    const { state, reason } = stateFromProbe(p, usage);
    // Codex signs in by account, not by key — the id_token's email claim names WHO is connected
    // (the operator runs several). Reason text only; the token itself never leaves the reader.
    const full = state === "connected" && auth.email ? `signed in as ${auth.email} · ${reason}` : reason;
    return row(p, { binary, auth, state, reason: full, usage: usage || undefined });
  } catch (e) {
    return row(p, { binary, auth, state: "unknown", reason: `live probe failed — ${shortError(e?.message || e)}` });
  }
}

// The frozen contract. opts: { env, home, path, now, probe } — everything a drill needs to stay
// hermetic: env defaults to the LAYERED crew resolution (process.env ∪ ~/.token-scrooge/.env ∪
// ~/.agent-bus/.env), home to the real one (which also unlocks the keychain read), probe to the
// balances-backed one.
export async function providerStatus(opts = {}) {
  const home = opts.home || homedir();
  const ctx = {
    home,
    allowKeychain: !opts.home,   // an injected home is a drill — never touch the operator keychain
    env: opts.env ?? resolveKeys(opts.env || process.env, [join(home, ".token-scrooge", ".env"), join(home, ".agent-bus", ".env")]),
    path: opts.path,
    now: opts.now || Date.now(),
    probe: opts.probe || balancesProbe,
  };
  return Promise.all(PROVIDERS.map((p) => buildRow(p, ctx)));
}

// The pre-save seam (#6391's ask): run the registry's OWN probe against a CANDIDATE key and write
// nothing anywhere. The row is the normal status row for that provider computed with the candidate
// injected — connected means the key is live BEFORE `provider add --key` commits it to .env.
export async function providerVerify(name, candidateKey, opts = {}) {
  const p = REG[String(name || "").toLowerCase()];
  if (!p) throw new Error(`unknown provider '${name}' — one of: ${PROVIDERS.map((x) => x.provider).join(", ")}`);
  const home = opts.home || homedir();
  const baseEnv = opts.env ?? resolveKeys(opts.env || process.env, [join(home, ".token-scrooge", ".env"), join(home, ".agent-bus", ".env")]);
  const env = candidateKey && p.envKeys[0] ? { ...baseEnv, [p.envKeys[0]]: candidateKey } : baseEnv;
  return buildRow(p, { home, allowKeychain: !opts.home, env, path: opts.path, now: opts.now || Date.now(), probe: opts.probe || balancesProbe });
}
