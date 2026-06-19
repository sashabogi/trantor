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

const H = homedir();
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const has = (c) => { try { execSync(`command -v ${c}`, { stdio: "ignore", shell: "/bin/sh" }); return true; } catch { return false; } };
const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m, fix) => { console.log(`  ✗ ${m}`); if (fix) console.log(`      → ${fix}`); issues++; };
let issues = 0;

console.log("TRANTOR DOCTOR\n");

// runtime + hub + client version
console.log("core");
Number(process.versions.node.split(".")[0]) >= 18 ? ok(`node ${process.versions.node}`) : warn(`node ${process.versions.node} too old`, "install node >= 18");
const cfg = read(join(H, ".agent-bus", "config.json")) || {};
const HUB = process.env.RELAY_URL || cfg.url || "http://127.0.0.1:4477";
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

// claude plugin
console.log("\nclaude (the orchestrator)");
if (!has("claude")) warn("claude CLI not found", "install Claude Code: https://claude.com/claude-code");
else {
  const st = read(join(H, ".claude", "settings.json")) || {};
  Object.keys(st.enabledPlugins || {}).some(k => k.startsWith("agent-bus@") || k.startsWith("trantor@"))
    ? ok("plugin installed")
    : warn("plugin not installed", "claude plugin marketplace add sashabogi/trantor && claude plugin install trantor");
}

// crew CLIs: installed / wired / authenticated
console.log("\ncrew CLIs (install any subset — seats follow the work)");
const CLIS = [
  { name: "codex",  bin: "codex",    wired: () => (readFileSync(join(H, ".codex", "config.toml"), "utf8")).includes("[mcp_servers.relay]"), auth: () => existsSync(join(H, ".codex", "auth.json")), login: "codex   (sign in with your ChatGPT account on first run)" },
  // Gemini CLI was retired 2026-06-18 for free/Pro/Ultra (Google → Antigravity `agy`). Kept as an
  // optional seat for enterprise/paid-key holders; for everyone else the seat moved to GLM/opencode,
  // and Gemini lives on only as a Scrooge cheap-model via GEMINI_API_KEY (the API/models aren't retired).
  { name: "gemini (CLI retired 2026-06-18)", bin: "gemini",   wired: () => !!read(join(H, ".gemini", "settings.json"))?.mcpServers?.relay, auth: () => existsSync(join(H, ".gemini", "oauth_creds.json")) || !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY, login: "Gemini CLI retired 2026-06-18 (free/Pro/Ultra). Crew seat → GLM (opencode) or Antigravity `agy`. Gemini still serves as a Scrooge cheap-model via GEMINI_API_KEY." },
  { name: "kimi",   bin: "kimi",     wired: () => !!read(join(H, ".kimi", "mcp.json"))?.mcpServers?.relay, auth: () => existsSync(join(H, ".kimi", "credentials")), login: "kimi → /login   (Kimi account or Moonshot API key)" },
  { name: "deepseek (via opencode)", bin: "opencode", wired: () => !!read(join(H, ".config", "opencode", "opencode.json"))?.mcp?.relay, auth: () => !!process.env.DEEPSEEK_API_KEY || (existsSync(join(H, ".agent-bus", ".env")) && readFileSync(join(H, ".agent-bus", ".env"), "utf8").includes("DEEPSEEK_API_KEY")) || !!read(join(H, ".local", "share", "opencode", "auth.json")), login: `get a key at platform.deepseek.com, then: echo 'DEEPSEEK_API_KEY=sk-…' >> ~/.agent-bus/.env` },
  { name: "glm (via opencode · coding plan)", bin: "opencode", wired: () => !!read(join(H, ".config", "opencode", "opencode.json"))?.mcp?.relay, auth: () => !!read(join(H, ".config", "opencode", "opencode.json"))?.provider?.["zai-coding-plan"]?.options?.apiKey, login: `put your Z.ai coding-plan key at ~/.config/opencode/opencode.json → provider["zai-coding-plan"].options.apiKey, then seat: trantor up opencode:zai-coding-plan/glm-5.1` },
];
let installed = 0;
for (const c of CLIS) {
  if (!has(c.bin)) { console.log(`  – ${c.name}: not installed (optional)`); continue; }
  installed++;
  let wired = false; try { wired = c.wired(); } catch {}
  wired ? ok(`${c.name}: wired to the bus`) : warn(`${c.name}: installed but not wired`, `node ${join(ROOT, "bin", "connect.mjs")}`);
  let authed = false; try { authed = c.auth(); } catch {}
  authed ? ok(`${c.name}: authenticated`) : warn(`${c.name}: NOT authenticated — it will join the bus but fail on its first turn`, c.login);
}
if (!installed) warn("no crew CLIs found", "install at least one of: codex, gemini, kimi, opencode — Trantor orchestrates whatever you have");

// brain
console.log("\nthe brain");
has("scrooge") || existsSync(join(H, ".local", "bin", "scrooge"))
  ? ok("economics engine installed (routing + cost ledger active)")
  : warn("economics engine missing — Advisor runs without live pricing; relay_scrooge dormant", "trantor setup   (installs it automatically)");
const prof = read(join(H, ".agent-bus", "profile.json"));
prof?.providers && Object.keys(prof.providers).length
  ? ok(`quota profile set (${Object.entries(prof.providers).map(([k, v]) => `${k}=${v.plan}`).join(", ")})`)
  : warn("quota profile not set — the Advisor will assume API billing everywhere", `node ${join(ROOT, "bin", "profile.mjs")} set claude=max codex=plus deepseek=api …  (use YOUR real plans)`);

console.log(issues ? `\n${issues} issue(s) — fix the → lines above, then re-run the doctor.` : "\nAll clear — open a claude session in any project and say: \"fire up the crew\".");
process.exit(issues ? 1 : 0);
