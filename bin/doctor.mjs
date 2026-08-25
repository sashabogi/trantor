#!/usr/bin/env node
// trantor doctor — tell a fresh user exactly where they stand and what to do next.
// Checks: runtime, hub, plugin, each CLI (installed? wired? AUTHENTICATED?), API keys,
// quota profile, optional Scrooge brain. Prints a checklist with copy-paste fixes.
//   node bin/doctor.mjs
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveProject, resolveHub, DEFAULT_HUB_URL } from "../lib/project.mjs";
import { loadOrCreate } from "../lib/identity.mjs";
import { scan } from "../lib/splitbrain.mjs";

const H = homedir();
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const has = (c) => { try { execSync(`command -v ${c}`, { stdio: "ignore", shell: "/bin/sh" }); return true; } catch { return false; } };
// Claude Code keeps its credentials in the macOS Keychain. Attribute-only lookup (no -w, no -g), so
// it never reads the secret and never raises an access prompt — a GUI prompt from a health check
// would be worse than the unknown it answers.
const keychainHas = (svc) => {
  if (process.platform !== "darwin") return false;
  try { execSync(`security find-generic-password -s ${JSON.stringify(svc)}`, { stdio: "ignore" }); return true; } catch { return false; }
};
const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
// --json makes the SAME engine feed the desktop app. Without it the app would have to re-implement
// detection (or parse this text), and the two would drift — the CLI would say a seat is wired while
// the app said otherwise, with no way to tell which was right.
const JSON_MODE = process.argv.includes("--json");
const REPORT = { ok: [], issues: [], notes: [], sections: [] };
let SECTION = "";
const say = (line) => { if (!JSON_MODE) console.log(line); };
const section = (name) => { SECTION = name; REPORT.sections.push(name); say((REPORT.sections.length > 1 ? "\n" : "") + name); };
const ok = (m) => { REPORT.ok.push({ section: SECTION, message: m }); say(`  ✓ ${m}`); };
const warn = (m, fix) => { REPORT.issues.push({ section: SECTION, message: m, fix: fix || null }); say(`  ✗ ${m}`); if (fix) say(`      → ${fix}`); issues++; };
const note = (m) => { REPORT.notes.push({ section: SECTION, message: m }); say(`  – ${m}`); };
let issues = 0;

say("TRANTOR DOCTOR\n");

// runtime + hub + client version
section("core");
Number(process.versions.node.split(".")[0]) >= 18 ? ok(`node ${process.versions.node}`) : warn(`node ${process.versions.node} too old`, "install node >= 18");
const cfg = read(join(H, ".agent-bus", "config.json")) || {};
// The hub THIS directory's project actually routes to — pins first. Reading only the global
// default meant the doctor could report a healthy local hub while every session in the project
// was talking to netcup, which is exactly the blindness the routing section below exists to end.
const PROJECT = resolveProject(process.cwd());
const HUB = resolveHub(PROJECT);
try {
  const h = await (await fetch(`${HUB}/health`, { signal: AbortSignal.timeout(2000) })).json();
  ok(`hub up at ${HUB} (${h.peers} peers known)`);
} catch {
  warn(`hub not reachable at ${HUB}`, `bash ${join(ROOT, "deploy", "setup.sh")}   # installs the always-on service`);
}

// version — heartbeat/presence support
const pkg = read(join(ROOT, "package.json"));
if (pkg?.version) {
  const min = [0, 17, 0];
  const cur = pkg.version.split(".").map(Number);
  const tooOld = cur[0] < min[0] || (cur[0] === min[0] && (cur[1] < min[1] || (cur[1] === min[1] && cur[2] < min[2])));
  tooOld ? warn(`trantor v${pkg.version} too old — heartbeat/presence requires v0.17.0+`, "npm update -g trantor") : ok(`trantor v${pkg.version}`);
} else warn("could not read trantor version", "reinstall: npm install -g trantor");

// ── hub routing: is any project split across two hubs? ───────────────────────────────────────
// Cards, messages and collision detection only work over ONE hub. A project split across two
// breaks silently — every seat reports healthy and half the work records where nobody looks.
section("hub routing");
{
  const pin = (cfg.hubs || {})[PROJECT] || "";
  say(`  ${PROJECT} → ${HUB}${pin ? "  (pinned)" : process.env.RELAY_URL ? "  (RELAY_URL override)" : "  (unpinned — falls back to the default)"}`);
  const owner = String(cfg.ownerIdentity || "");
  // Unsigned, an enforce hub answers "signature required" and a full hub reads as deserted. Sign
  // as the owner when we have one, and say plainly when we cannot rather than guessing.
  const identity = owner ? (() => { try { return loadOrCreate(owner, "human"); } catch { return null; } })() : null;
  if (!identity) note("no owner identity in config — hubs are probed UNSIGNED, so an enforce hub will refuse the read");
  let scanned = null;
  try { scanned = await scan(cfg, identity, { defaultUrl: DEFAULT_HUB_URL, timeoutMs: 6000 }); }
  catch (e) { note(`split-brain check could not run (${e?.message || e})`); }
  if (scanned) {
    REPORT.splitbrain = { findings: scanned.findings, blind: scanned.blind, checked: scanned.checked };
    for (const b of scanned.blind) warn(`hub ${b.url} could not be read — ${b.reason}`, "detection is PARTIAL until this hub answers; a split hiding behind it will not be reported");
    for (const f of scanned.findings) f.severity === "warn" ? warn(f.message, f.fix) : warn(`SPLIT-BRAIN — ${f.message}`, f.fix);
    if (!scanned.findings.length && !scanned.blind.length) ok(`no split-brain — every live project sits on exactly one hub (${scanned.checked} hub${scanned.checked === 1 ? "" : "s"} cross-checked)`);
    else if (!scanned.findings.length) ok(`no split-brain among the ${scanned.checked} hub${scanned.checked === 1 ? "" : "s"} that answered`);
  }
}

// claude plugin
section("claude (the orchestrator)");
if (!has("claude")) warn("claude CLI not found", "install Claude Code: https://claude.com/claude-code");
else {
  const st = read(join(H, ".claude", "settings.json")) || {};
  Object.keys(st.enabledPlugins || {}).some(k => k.startsWith("agent-bus@") || k.startsWith("trantor@"))
    ? ok("plugin installed")
    : warn("plugin not installed", "claude plugin marketplace add sashabogi/trantor && claude plugin install trantor");
}

// crew CLIs: installed / wired / authenticated
section("crew CLIs (install any subset — seats follow the work)");
const CLIS = [
  // Claude is a SEAT, not only the orchestrator — crew-runner.mjs has a `claude` entry and the fleet
  // duty agent runs on it. It was checked only under "claude (the orchestrator)", which the Agents
  // view filters out, so the one harness that is always present had no card. Wired = the plugin,
  // since that is what carries the relay MCP server into the session.
  { name: "claude", bin: "claude",
    wired: () => Object.keys((read(join(H, ".claude", "settings.json")) || {}).enabledPlugins || {}).some(k => k.startsWith("agent-bus@") || k.startsWith("trantor@")),
    auth: () => !!process.env.ANTHROPIC_API_KEY || existsSync(join(H, ".claude", ".credentials.json")) || keychainHas("Claude Code-credentials"),
    login: "claude   (sign in with your Anthropic account on first run)" },
  { name: "codex",  bin: "codex",  wired: () => (readFileSync(join(H, ".codex", "config.toml"), "utf8")).includes("[mcp_servers.relay]"), auth: () => existsSync(join(H, ".codex", "auth.json")), login: "codex   (sign in with your ChatGPT account on first run)" },
  // Gemini CLI was retired 2026-06-18 for free/Pro/Ultra (Google → Antigravity `agy`). Kept as an
  // optional seat for enterprise/paid-key holders; for everyone else the seat moved to GLM/opencode,
  // and Gemini lives on only as a Scrooge cheap-model via GEMINI_API_KEY (the API/models aren't retired).
  { name: "gemini (CLI retired 2026-06-18)", bin: "gemini",   wired: () => !!read(join(H, ".gemini", "settings.json"))?.mcpServers?.relay, auth: () => existsSync(join(H, ".gemini", "oauth_creds.json")) || !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY, login: "Gemini CLI retired 2026-06-18 (free/Pro/Ultra). Crew seat → GLM (opencode) or Antigravity `agy`. Gemini still serves as a Scrooge cheap-model via GEMINI_API_KEY." },
  { name: "kimi",   bin: "kimi",     wired: () => !!read(join(H, ".kimi", "mcp.json"))?.mcpServers?.relay, auth: () => existsSync(join(H, ".kimi", "credentials")), login: "kimi → /login   (Kimi account or Moonshot API key)" },
  { name: "deepseek (via opencode)", bin: "opencode", wired: () => !!read(join(H, ".config", "opencode", "opencode.json"))?.mcp?.relay, auth: () => !!process.env.DEEPSEEK_API_KEY || (existsSync(join(H, ".agent-bus", ".env")) && readFileSync(join(H, ".agent-bus", ".env"), "utf8").includes("DEEPSEEK_API_KEY")) || !!read(join(H, ".local", "share", "opencode", "auth.json")), login: `get a key at platform.deepseek.com, then: echo 'DEEPSEEK_API_KEY=sk-…' >> ~/.agent-bus/.env` },
  { name: "glm (via opencode · coding plan)", bin: "opencode", wired: () => !!read(join(H, ".config", "opencode", "opencode.json"))?.mcp?.relay, auth: () => !!read(join(H, ".config", "opencode", "opencode.json"))?.provider?.["zai-coding-plan"]?.options?.apiKey, login: `put your Z.ai coding-plan key at ~/.config/opencode/opencode.json → provider["zai-coding-plan"].options.apiKey, then seat: trantor up glm:zai-coding-plan/glm-5.1` },
  // DeepSeek Harness — the open-source harness (everything-is-a-plugin). Wired = the trantor
  // profile exists (built by `trantor connect`: their CC-hooks bridge running OUR hooks + their MCP
  // client running our relay). API-billed via DEEPSEEK_API_KEY, same key the opencode deepseek seat uses.
  { name: "dsh (DeepSeek Harness)", bin: "dsh",
    wired: () => existsSync(join(H, ".dsh", "profiles", "trantor", "cordis.patch.yml")),
    auth: () => !!process.env.DEEPSEEK_API_KEY || [join(H, ".token-scrooge", ".env"), join(H, ".agent-bus", ".env")].some(f => { try { return readFileSync(f, "utf8").includes("DEEPSEEK_API_KEY"); } catch { return false; } }),
    login: "npm i -g @deepseek-ai/dsh && trantor connect   (uses DEEPSEEK_API_KEY). Seat: trantor up dsh" },
  // OpenRouter — the BYOM on-ramp: ONE key fronts hundreds of models. Rides opencode; the same
  // OPENROUTER_API_KEY Scrooge already uses authenticates the crew seat (the runner sources the
  // .env files). Available the moment the key exists in env/opencode + declared `openrouter=api`.
  { name: "openrouter (via opencode · BYOM, hundreds of models)", bin: "opencode", wired: () => !!read(join(H, ".config", "opencode", "opencode.json"))?.mcp?.relay, auth: () => !!process.env.OPENROUTER_API_KEY || !!read(join(H, ".config", "opencode", "opencode.json"))?.provider?.openrouter?.options?.apiKey || [join(H, ".token-scrooge", ".env"), join(H, ".agent-bus", ".env")].some(f => { try { return readFileSync(f, "utf8").includes("OPENROUTER_API_KEY"); } catch { return false; } }), login: `get a key at openrouter.ai/keys, then: echo 'OPENROUTER_API_KEY=sk-or-…' >> ~/.agent-bus/.env && trantor profile set openrouter=api && scrooge-capabilities (scores the catalog so the crew routes it by difficulty). Seat: trantor up openrouter (live-selects) or pin trantor up openrouter:openrouter/<vendor>/<model>` },
];
let installed = 0;
for (const c of CLIS) {
  if (!has(c.bin)) { note(`${c.name}: not installed (optional)`); continue; }
  installed++;
  let wired = false; try { wired = c.wired(); } catch {}
  wired ? ok(`${c.name}: wired to the bus`) : warn(`${c.name}: installed but not wired`, `node ${join(ROOT, "bin", "connect.mjs")}`);
  let authed = false; try { authed = c.auth(); } catch {}
  authed ? ok(`${c.name}: authenticated`) : warn(`${c.name}: NOT authenticated — it will join the bus but fail on its first turn`, c.login);
}
if (!installed) warn("no crew CLIs found", "install at least one of: codex, gemini, kimi, opencode — Trantor orchestrates whatever you have");

// ---- key attribution: WHICH key does each surface actually spend on? ------------------------
// Provider keys resolve through a LAYERED lookup and nothing ever showed which layer won. On
// 2026-08-25 a $14 DeepSeek day could not be explained: ~/.token-scrooge/.env held the only
// DEEPSEEK_API_KEY, so Scrooge's `dev-infra` key was ALSO authenticating every crew seat (the
// runner sources that file). Scrooge turned out to be 0.15% of the tokens on that key and the
// crew was the other 99.85%, but the bill could not say so — one key, two jobs, one line item.
//
// The layers, highest priority first — this MIRRORS bin/crew-runner.mjs, which sources
// ~/.agent-bus/.env last so it wins:
//   1. the process environment
//   2. ~/.agent-bus/.env      — the CREW layer (seats: opencode/deepseek/openrouter/dsh)
//   3. ~/.token-scrooge/.env  — the SCROOGE layer (cheap-model grunt routing)
section("provider keys (who spends on what)");
const KEY_VARS = ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "MOONSHOT_API_KEY", "ZAI_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"];
// Only some of these are a CREW credential. A seat that authenticates through its own config never
// reads the env var at all, so a shared value there costs nothing and flagging it is noise:
//   glm    → opencode.json provider["zai-coding-plan"].options.apiKey  (and a coding plan is flat
//            rate, so there is no per-token bill to attribute even in principle)
//   kimi   → ~/.kimi/credentials      codex → its own login      gemini → retired
// The opencode-driven seats that DO take their key from the env layer are deepseek and openrouter,
// and even then only when opencode.json has not already given that provider its own key.
// Getting this wrong cries wolf: the first version flagged all seven and five were false positives,
// which is how a doctor becomes something you skip.
const OPENCODE_CFG = read(join(H, ".config", "opencode", "opencode.json")) || {};
const SEAT_ENV_VARS = { DEEPSEEK_API_KEY: "deepseek", OPENROUTER_API_KEY: "openrouter" };
const crewUsesVar = (v) => {
  const provider = SEAT_ENV_VARS[v];
  if (!provider) return false;
  const configured = OPENCODE_CFG?.provider?.[provider]?.options?.apiKey;
  if (typeof configured === "string" && configured.includes("{env:")) return true;   // resolves from env at run time
  return !configured;                                                                 // a LITERAL key bypasses the env layer
};
const CREW_ENV = join(H, ".agent-bus", ".env");
const SCROOGE_ENV = join(H, ".token-scrooge", ".env");
const readEnvFile = (f) => {
  const out = {};
  try {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
};
// Never print a key. The suffix is enough to match a line item in a provider console.
const mask = (v) => (!v ? "" : v.length <= 12 ? "****" : `${v.slice(0, 5)}…${v.slice(-4)}`);
const crewEnv = readEnvFile(CREW_ENV), scroogeEnv = readEnvFile(SCROOGE_ENV);
let anyKey = false, shared = 0; const sharedVars = [];
for (const v of KEY_VARS) {
  const crew = process.env[v] || crewEnv[v] || "";
  const scrooge = process.env[v] || scroogeEnv[v] || "";
  if (!crew && !scrooge) continue;
  anyKey = true;
  const crewSrc = process.env[v] ? "process env" : crewEnv[v] ? "~/.agent-bus/.env (crew)" : scroogeEnv[v] ? "~/.token-scrooge/.env (FALLBACK)" : "none";
  const crewKey = crew || scrooge;
  const scroogeFileKey = scroogeEnv[v] || "";
  if (!crewUsesVar(v)) {
    ok(`${v}: Scrooge only ${mask(scroogeFileKey || crewKey)} — no crew seat reads this var`);
  } else if (crewKey && scroogeFileKey && crewKey === scroogeFileKey) {
    shared++; sharedVars.push(v);
    note(`${v}: crew + Scrooge share ONE key ${mask(crewKey)} — spend is indistinguishable on the bill`);
  } else {
    ok(`${v}: crew ${mask(crewKey)} via ${crewSrc}${scroogeFileKey && scroogeFileKey !== crewKey ? ` · scrooge ${mask(scroogeFileKey)} via ~/.token-scrooge/.env` : ""}`);
  }
}
if (!anyKey) note("no provider API keys found in env, ~/.agent-bus/.env or ~/.token-scrooge/.env");
else if (!shared) ok("crew and Scrooge spend on separate keys — each shows up as its own line item");
else {
  warn(`${shared} provider key(s) do double duty (${sharedVars.join(", ")}) — a spike on the bill cannot be attributed to the crew or to Scrooge`,
    `mint a second key per provider and give the CREW its own, e.g.: echo 'DEEPSEEK_API_KEY=<new-crew-key>' >> ~/.agent-bus/.env   (Scrooge keeps ~/.token-scrooge/.env; the runner sources ~/.agent-bus/.env last, so it wins)`);
}

// brain
section("the brain");
has("scrooge") || existsSync(join(H, ".local", "bin", "scrooge"))
  ? ok("economics engine installed (routing + cost ledger active)")
  : warn("economics engine missing — Advisor runs without live pricing; relay_scrooge dormant", "trantor setup   (installs it automatically)");
const prof = read(join(H, ".agent-bus", "profile.json"));
prof?.providers && Object.keys(prof.providers).length
  ? ok(`quota profile set (${Object.entries(prof.providers).map(([k, v]) => `${k}=${v.plan}`).join(", ")})`)
  : warn("quota profile not set — the Advisor will assume API billing everywhere", `node ${join(ROOT, "bin", "profile.mjs")} set claude=max codex=plus deepseek=api …  (use YOUR real plans)`);

say(issues ? `\n${issues} issue(s) — fix the → lines above, then re-run the doctor.` : "\nAll clear — open a claude session in any project and say: \"fire up the crew\".");
// Must come BEFORE the exit — process.exit() here truncated the report entirely.
if (JSON_MODE) console.log(JSON.stringify({ ...REPORT, issueCount: issues }));
process.exit(issues ? 1 : 0);
