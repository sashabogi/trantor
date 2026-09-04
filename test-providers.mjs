#!/usr/bin/env node
// test-providers.mjs — the #6390 gate: EVERY registry state proven from stubbed seams.
// Seams (no module mocking, no network): opts.home (artifact paths), opts.env (keys), opts.path
// (binary detect — a fake bin dir can make `kimi` exist), opts.probe (the balances-backed live
// check), opts.now. The frozen contract the Accounts pane (#6391) and wizard (#6392) build
// against is asserted row-shape-exact: state + reason are NEVER blank (the kimi-bar rule).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drillEnv } from "./drill-env.mjs";
import { PROVIDERS, STATES, ACTIONS, providerStatus, providerVerify, balancesProbeForDrills } from "./lib/providers.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { const line = `${cond ? "✓" : "✗ FAIL"} ${name}${cond || !extra ? "" : " — " + extra}`; console.log(line); cond ? pass++ : fail++; };

const mkHome = () => mkdtempSync(join(tmpdir(), "trantor-provreg-"));
const NOW = 1757000000000;

// A fake bin dir whose executables satisfy `command -v` without any real CLI.
const mkBin = (...names) => {
  const dir = mkdtempSync(join(tmpdir(), "trantor-provbin-"));
  for (const n of names) {
    const f = join(dir, n);
    writeFileSync(f, "#!/bin/sh\nexit 0\n");
    chmodSync(f, 0o755);
  }
  return dir;
};

// Probe stub: keyed by provider name; tracks calls so drills can assert a probe RAN or didn't.
const stubProbe = (table) => {
  const calls = [];
  const fn = async (name) => {
    calls.push(name);
    const r = table[name];
    if (r === undefined) return null;
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
};

const statusOf = async (table, { home = mkHome(), env = {}, bin = [], now = NOW, key } = {}) => {
  const probe = stubProbe(table);
  const e = key ? { ...env, ...key } : env;
  const rows = await providerStatus({ home, env: e, path: bin.length ? mkBin(...bin) : mkdtempSync(join(tmpdir(), "trantor-provempty-")), now, probe });
  return { rows, probe };
};
const one = async (provider, table, opts = {}) => (await statusOf(table, opts)).rows.find((r) => r.provider === provider);

// --- 1. the frozen contract: row shape exact, state ∈ enum, actions ⊆ enum, reason NEVER blank ---
{
  const home = mkHome();
  // Real artifacts for the two OAuth providers, so their LIVE probes actually run.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: new Date(NOW + 86400e3).toISOString() } }));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "a", id_token: `x.${Buffer.from(JSON.stringify({ email: "sasha@crebral.ai" })).toString("base64url")}.y` } }));
  const table = {
    claude: { provider: "claude", ok: true, kind: "windows", windows: [{ name: "5h", usedPct: 19 }] },
    codex: { provider: "codex", ok: true, kind: "windows", plan: "ChatGPT prolite", windows: [{ name: "7d", usedPct: 4 }] },
    kimi: { provider: "kimi", ok: true, kind: "quota", remainingPct: 40, plan: "intermediate" },
    zai: { provider: "zai", ok: true, kind: "quota", remainingPct: 66, plan: "GLM Coding Pro" },
    qwen: { provider: "qwen", ok: true, kind: "quota", remainingPct: 0, plan: "token plan", detail: "7-day token plan exhausted" },
    deepseek: { provider: "deepseek", ok: true, kind: "prepaid", remaining: 34.16, currency: "USD" },
    openrouter: { provider: "openrouter", ok: true, kind: "prepaid", remaining: 19.25, currency: "USD" },
    moonshot: { provider: "moonshot", ok: true, kind: "prepaid", remaining: 80, currency: "CNY" },
    dsh: { provider: "dsh", ok: true, kind: "prepaid", remaining: 12, currency: "USD" },
  };
  const { rows, probe } = await statusOf(table, { home, env: { KIMI_API_KEY: "sk-k", ZAI_API_KEY: "sk-z", QWEN_API_KEY: "sk-q", DEEPSEEK_API_KEY: "sk-d", OPENROUTER_API_KEY: "sk-o", MOONSHOT_API_KEY: "sk-m" }, bin: ["claude", "codex", "kimi", "opencode", "qwen", "agy", "dsh"] });
  ok("one row per registry provider, registry order", rows.length === PROVIDERS.length && rows.every((r, i) => r.provider === PROVIDERS[i].provider));
  const FROZEN = ["provider", "label", "kind", "connect", "binary", "auth", "state", "reason", "usage", "actions"];
  ok("every row carries EXACTLY the frozen keys", rows.every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(FROZEN)), JSON.stringify(rows[0] && Object.keys(rows[0])));
  ok("binary is {name, installed, path}", rows.every((r) => JSON.stringify(Object.keys(r.binary)) === JSON.stringify(["name", "installed", "path"])));
  ok("auth is {artifact, present, mode}", rows.every((r) => JSON.stringify(Object.keys(r.auth)) === JSON.stringify(["artifact", "present", "mode"])));
  ok("every state is a known one", rows.every((r) => STATES.includes(r.state)), rows.map((r) => `${r.provider}=${r.state}`).join(" "));
  ok("every reason is non-blank (the kimi-bar rule)", rows.every((r) => String(r.reason ?? "").trim().length > 0));
  ok("actions are always a subset of the frozen set", rows.every((r) => r.actions.length && r.actions.every((a) => ACTIONS.includes(a))));
  ok("usage is always an object carrying ok", rows.every((r) => r.usage && Object.hasOwn(r.usage, "ok")));
  ok("connected providers probe LIVE, artifacts alone never read as connected", probe.calls.includes("claude") && probe.calls.includes("codex"));
}

// --- 2. per-state proofs ---
// not_installed: the CLI is the product — no binary, no seat, decided BEFORE any probe.
{
  const r = await one("kimi", {}, {});
  ok("cli-login without its binary → not_installed", r.state === "not_installed", r.reason);
  ok("not_installed reason names the missing binary", /kimi/.test(r.reason) && /PATH/.test(r.reason), r.reason);
  ok("not_installed offers recheck, never login (nothing to log into yet)", r.actions.includes("recheck") && !r.actions.includes("login"));
}
// not_logged_in (cli-login): binary present, artifact absent — reason names artifact + fix.
{
  let probed = false;
  const r = await one("kimi", { kimi: async () => { probed = true; return { ok: true }; } }, { bin: ["kimi"] });
  ok("cli-login with binary but no credential → not_logged_in", r.state === "not_logged_in", r.reason);
  ok("not_logged_in reason names the artifact AND the login fix", /\.kimi\/credentials/.test(r.reason) && /login/.test(r.reason), r.reason);
  ok("not_logged_in skips the probe (it would only echo the miss back)", !probed);
  ok("not_logged_in actions lead with login", r.actions[0] === "login" && r.actions.includes("recheck") && r.actions.includes("remove"));
}
// not_logged_in (api-key): no key anywhere → paste-key, no probe.
{
  const r = await one("deepseek", {}, { bin: ["opencode"] });
  ok("api-key provider with no key → not_logged_in", r.state === "not_logged_in", r.reason);
  ok("api-key not_logged_in actions lead with paste-key", r.actions[0] === "paste-key");
}
// connected: the LIVE call answered — whatever the numbers say.
{
  const { rows } = await statusOf({ deepseek: { provider: "deepseek", ok: true, kind: "prepaid", remaining: 10, currency: "USD" } }, { env: { DEEPSEEK_API_KEY: "sk-live" }, bin: ["opencode"] });
  const r = rows.find((x) => x.provider === "deepseek");
  ok("a live usage call that answered → connected", r.state === "connected", r.reason);
  ok("connected reason carries the number the probe measured", r.reason.includes("10"), r.reason);
  ok("connected usage is the balances row itself", r.usage.ok === true && r.usage.remaining === 10);
}
// over_quota: a spent quota plan ANSWERS ok with 0% left (qwen's wall) — that is over_quota, not connected.
{
  const r = await one("qwen", { qwen: { provider: "qwen", ok: true, kind: "quota", remainingPct: 0, plan: "token plan", detail: "7-day token plan exhausted", resetTime: NOW + 3 * 86400e3 } }, { env: { QWEN_API_KEY: "sk-q" }, bin: ["qwen", "opencode"] });
  ok("ok-but-0% quota → over_quota (the qwen wall)", r.state === "over_quota", r.reason);
  ok("over_quota reason carries the reset", /exhausted/.test(r.reason) && /resets/.test(r.reason), r.reason);
}
// expired (proven without a round trip): an explicitly-expired credential is decided offline.
{
  const home = mkHome();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: new Date(NOW - 1000).toISOString() } }));
  const r = await one("claude", { claude: { provider: "claude", ok: true } }, { home, bin: ["claude"] });
  ok("an expired OAuth artifact → expired, probe skipped", r.state === "expired" && !/probe/i.test(r.reason), r.reason);
}
// expired (probe 401): a rejected login token on a cli-login provider.
{
  const home = mkHome();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: new Date(NOW + 86400e3).toISOString() } }));
  const r = await one("claude", { claude: { provider: "claude", ok: false, error: "usage endpoint 401" } }, { home, bin: ["claude"] });
  ok("a 401 on a cli-login provider → expired (re-auth), not unknown", r.state === "expired", r.reason);
}
// not_logged_in (probe 401): a rejected KEY on an api-key provider.
{
  const r = await one("deepseek", { deepseek: { provider: "deepseek", ok: false, error: "HTTP 401 — invalid key" } }, { env: { DEEPSEEK_API_KEY: "sk-dead" }, bin: ["opencode"] });
  ok("a 401 on an api-key provider → not_logged_in (paste a fresh key)", r.state === "not_logged_in" && /rejected/i.test(r.reason), r.reason);
  ok("rejected-key actions lead with paste-key", r.actions[0] === "paste-key");
}
// unknown: a probe that fails for neither auth nor quota.
{
  const r = await one("deepseek", { deepseek: { provider: "deepseek", ok: false, error: "HTTP 500 — boom" } }, { env: { DEEPSEEK_API_KEY: "sk-x" }, bin: ["opencode"] });
  ok("an unrelated probe failure → unknown, reason carries the error", r.state === "unknown" && /boom/.test(r.reason), r.reason);
  ok("a THROWING probe is fail-soft → unknown, never an exception out", ((await one("deepseek", { deepseek: new Error("socket gone") }, { env: { DEEPSEEK_API_KEY: "sk-x" }, bin: ["opencode"] })).state) === "unknown");
}
// THE REAL-MACHINE SHAPE (2026-09-04): qwen authenticates by API key on a machine with no qwen
// CLI — the binary gate must not hide the account truth. Auth present → the probe decides.
{
  const r = await one("qwen", { qwen: { provider: "qwen", ok: true, kind: "quota", remainingPct: 0, plan: "token plan", detail: "7-day token plan exhausted", resetTime: NOW + 3 * 86400e3 } }, { env: { QWEN_API_KEY: "sk-q" } });
  ok("authed provider without its binary still probes → over_quota, not not_installed", r.state === "over_quota", r.reason);
  ok("the missing binary rides its own contract field for the pane to render", r.binary.installed === false && r.binary.name === "qwen");
}
// THE NAMESAKE BUG: kimi answered, remainingPct is null (plan numbers the key can't read) — the
// row used to render a blank "plan". Now: connected + the adapter's detail line as the reason.
{
  const r = await one("kimi", { kimi: { provider: "kimi", ok: true, kind: "quota", remainingPct: null, plan: "intermediate", detail: "100% in 5h window" } }, { env: { KIMI_API_KEY: "sk-k" }, bin: ["kimi"] });
  ok("kimi with no readable % is still CONNECTED (the call answered)", r.state === "connected", r.reason);
  ok("kimi's reason is the window detail — never a blank plan", r.reason.includes("100% in 5h window") && r.reason.trim().length > 0, r.reason);
}
// moonshot carries NO binary by design — key-only must not read as not_installed.
{
  const r = await one("moonshot", { moonshot: { provider: "moonshot", ok: true, kind: "prepaid", remaining: 80, currency: "CNY" } }, { env: { MOONSHOT_API_KEY: "sk-m" } });
  ok("a key-only provider (no binary) with a live probe → connected", r.state === "connected", r.reason);
  ok("moonshot binary is present-but-null named", r.binary.name === null && r.binary.installed === false);
}
// codex: chatgpt mode, the id_token names the account in the reason.
{
  const home = mkHome();
  const jwt = `x.${Buffer.from(JSON.stringify({ email: "sasha@crebral.ai" })).toString("base64url")}.y`;
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "a", id_token: jwt, account_id: "acc" }, last_refresh: "2026-09-01" }));
  const r = await one("codex", { codex: { provider: "codex", ok: true, kind: "windows", plan: "ChatGPT prolite", windows: [{ name: "7d", usedPct: 4 }] } }, { home, bin: ["codex"] });
  ok("codex auth.json with tokens → mode chatgpt", r.auth.mode === "chatgpt" && r.auth.present === true, JSON.stringify(r.auth));
  ok("codex connected reason names the SIGNED-IN ACCOUNT and the plan", /sasha@crebral\.ai/.test(r.reason) && /prolite/.test(r.reason), r.reason);
}
// opencode-wired LITERAL key feeds the probe even with no env key ({env:…} templates defer to env).
{
  const home = mkHome();
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ provider: { "zai-coding-plan": { options: { apiKey: "literal-zai-key" } } } }));
  const probe = stubProbe({ zai: { provider: "zai", ok: true, kind: "quota", remainingPct: 66, plan: "GLM Coding Pro" } });
  await providerStatus({ home, env: {}, probe, path: mkBin("opencode") });
  ok("a literal opencode.json key is fed to the probe", probe.calls.includes("zai"));
  const probe2 = stubProbe({});
  const rows2 = await providerStatus({ home: mkHome(), env: {}, probe: probe2, path: mkBin("opencode") });
  ok("no key in env or config → zai reads not_logged_in, probe never runs", rows2.find((r) => r.provider === "zai").state === "not_logged_in" && !probe2.calls.includes("zai"));
}
// dsh probes THROUGH the deepseek adapter and the row is rebranded — no duplicated probe.
{
  const r = await balancesProbeForDrills("dsh", {}, async () => [{ provider: "deepseek", ok: true, kind: "prepaid", remaining: 5, currency: "USD" }]);
  ok("dsh's probe rides the deepseek adapter and is rebranded to dsh", r.provider === "dsh" && r.remaining === 5, JSON.stringify(r));
}
// agy: installed but no probe wired — honest unknown, never "binary exists = connected".
{
  const r = await one("agy", {}, { bin: ["agy"] });
  ok("agy installed with no probe → unknown with a how-to-check reason", r.state === "unknown" && /agy/.test(r.reason), r.reason);
}

// --- 3. the verify seam: a CANDIDATE key is probed, NOTHING is written ---
{
  const home = mkHome();
  const r = await providerVerify("deepseek", "sk-candidate", { home, env: {}, probe: stubProbe({ deepseek: { provider: "deepseek", ok: true, kind: "prepaid", remaining: 3, currency: "USD" } }), path: mkBin("opencode") });
  ok("verify with a live candidate key → connected", r.state === "connected", r.reason);
  ok("verify wrote NOTHING to the fake home", !existsSync(join(home, ".agent-bus", ".env")) && !existsSync(join(home, ".agent-bus", "profile.json")));
  const bad = await providerVerify("deepseek", "sk-dead", { home, env: {}, probe: stubProbe({ deepseek: { provider: "deepseek", ok: false, error: "HTTP 401 — invalid_api_key" } }), path: mkBin("opencode") });
  ok("verify with a dead candidate key → not_logged_in BEFORE any save", bad.state === "not_logged_in" && /rejected/i.test(bad.reason), bad.reason);
  let threw = false;
  try { await providerVerify("nope", "sk-x", {}); } catch { threw = true; }
  ok("verify of an unknown provider dies loudly", threw);
}

// --- 4. the CLI: --json output IS the frozen contract; human output has both boards ---
{
  const fake = mkHome();
  const childEnv = drillEnv({ HOME: fake, PATH: "/usr/bin:/bin", TMPDIR: tmpdir(), TRANTOR_NO_KEYCHAIN: "1" });
  for (const k of Object.keys(childEnv)) if (/_(API_KEY|TOKEN)$/.test(k)) delete childEnv[k];   // no real key may reach the drill
  const run = (args) => spawnSync(process.execPath, [join(ROOT, "bin", "provider.mjs"), ...args], { encoding: "utf8", env: childEnv, timeout: 60000 });
  const st = run(["status", "--json"]);
  ok("status --json exits 0", st.status === 0, st.stderr);
  let rows = [];
  try { rows = JSON.parse(st.stdout); } catch {}
  ok("status --json prints the frozen array", Array.isArray(rows) && rows.length === PROVIDERS.length);
  ok("CLI rows all carry a state and a non-blank reason (offline machine, no network needed)",
    Array.isArray(rows) && rows.every((r) => STATES.includes(r.state) && r.reason && r.reason.trim().length > 0),
    st.stdout.slice(0, 200));
  const vf = run(["verify", "deepseek", "--key", "sk-candidate-drill", "--json"]);
  ok("verify --json exits 0 and names the provider", vf.status === 0 && JSON.parse(vf.stdout).provider === "deepseek", vf.stderr);
  ok("verify CLI wrote no .env in the fake home", !existsSync(join(fake, ".agent-bus", ".env")));
  const human = run(["status"]);
  ok("human status renders the PROVIDERS board with states and reasons",
    human.status === 0 && human.stdout.includes("PROVIDERS") && (human.stdout.match(/not_installed|not_logged_in|connected|expired|over_quota|unknown/g) || []).length >= PROVIDERS.length, human.stdout.slice(0, 120));
  const noKey = run(["verify", "deepseek"]);
  ok("verify without --key prints usage and exits 1", noKey.status === 1 && /usage:/.test(noKey.stderr));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
