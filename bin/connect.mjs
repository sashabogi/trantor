#!/usr/bin/env node
// trantor connect — wire every AI coding CLI on this machine to the bus, in one shot.
//
//   node bin/connect.mjs            # detect installed CLIs, patch each one's MCP config (idempotent)
//   node bin/connect.mjs --dry-run  # show what would change, touch nothing
//
// Each CLI keeps its own MCP config file/format; this writes the one "relay" entry into each
// (with a timestamped .bak backup the first time it changes a file). Claude Code is handled by
// the plugin (claude plugin install trantor), so it's only verified here, not patched.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DRY = process.argv.includes("--dry-run");
const MCP = join(dirname(dirname(fileURLToPath(import.meta.url))), "mcp.mjs");
const URL_ = process.env.RELAY_URL || "http://127.0.0.1:4477";
const has = (cmd) => { try { execSync(`command -v ${cmd}`, { stdio: "ignore", shell: "/bin/sh" }); return true; } catch { return false; } };
const stamp = new Date().toISOString().slice(0, 10);
const backup = (p) => { const b = `${p}.bak-${stamp}`; if (!existsSync(b)) copyFileSync(p, b); return b; };
const out = [];
const report = (cli, status, detail = "") => out.push({ cli, status, detail });

function patchJson(path, mutate) {
  const exists = existsSync(path);
  const d = exists ? JSON.parse(readFileSync(path, "utf8")) : {};
  const before = JSON.stringify(d);
  mutate(d);
  if (JSON.stringify(d) === before) return "already wired";
  if (!DRY) {
    if (exists) backup(path); else mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
  }
  return exists ? "wired" : "wired (new config)";
}

// NO RELAY_URL here. A hardcoded URL in a CLI's MCP config OVERRIDES the per-project hub pin
// (env wins in resolveHub), which silently sent every crew seat's relay tools to the local hub
// while its runner sat on the pinned one — the residual split-brain mechanism (2026-08-20).
// mcp.mjs resolves the hub from the session's project pin; that resolution must stay in charge.
const relayEnv = (agent) => ({ RELAY_AGENT: agent });

// ---- Claude Code: plugin handles it; verify only ----
if (has("claude")) {
  let st = "plugin not detected — run: claude plugin marketplace add sashabogi/trantor && claude plugin install trantor";
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    if (Object.keys(s.enabledPlugins || {}).some(k => k.startsWith("trantor@") || k.startsWith("agent-bus@"))) st = "plugin installed ✓";
  } catch {}
  report("claude", st);
}

// ---- Codex (TOML append — no TOML lib needed) ----
if (has("codex")) {
  const p = join(homedir(), ".codex", "config.toml");
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (cur.includes("[mcp_servers.relay]")) report("codex", "already wired");
  else {
    const block = `\n# trantor — auto-registers each Codex session on the bus + adds relay_* tools\n# (no RELAY_URL on purpose: the per-project hub pin decides the hub)\n[mcp_servers.relay]\ncommand = "node"\nargs = ["${MCP}"]\nenv = { RELAY_AGENT = "codex" }\n`;
    if (!DRY) { if (existsSync(p)) backup(p); else mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, cur + block); }
    report("codex", cur ? "wired" : "wired (new config)", p);
  }
}

// ---- Gemini CLI ----  (existing relay entries are never overwritten — user customization wins)
if (has("gemini")) {
  const p = join(homedir(), ".gemini", "settings.json");
  report("gemini", patchJson(p, d => {
    d.mcpServers ||= {};
    d.mcpServers.relay ||= { command: "node", args: [MCP], env: relayEnv("gemini") };
  }), p);
}

// ---- Kimi CLI ----
if (has("kimi")) {
  const p = join(homedir(), ".kimi", "mcp.json");
  report("kimi", patchJson(p, d => {
    d.mcpServers ||= {};
    d.mcpServers.relay ||= { command: "node", args: [MCP], env: relayEnv("kimi") };
  }), p);
}

// ---- OpenCode ----
if (has("opencode")) {
  const p = join(homedir(), ".config", "opencode", "opencode.json");
  report("opencode", patchJson(p, d => {
    d.$schema ||= "https://opencode.ai/config.json";
    d.mcp ||= {};
    d.mcp.relay ||= { type: "local", command: ["node", MCP], enabled: true, environment: relayEnv("opencode") };
  }), p);
}

// ---- DeepSeek Harness (dsh) ----
// dsh has no single MCP config file — composition is a PROFILE (~/.dsh/profiles/<name>): a package.json
// naming the bundles it stacks and a cordis.patch.yml inserting plugin rows. We build a "trantor"
// profile on the stock headless bundle and mount two rows:
//   1. their Claude Code hooks bridge pointed at OUR hooks.json — presence, focus cards, heartbeats,
//      file claims run inside dsh exactly as they do inside CC (verified live 2026-08-19);
//   2. their MCP client spawning our relay server — relay_* tools with the seat identity forwarded
//      from the ambient RELAY_* env (crew-runner sets those per seat).
// The bridge's own protocol lib is declared as a dependency explicitly: the rc package forgets it
// (ERR_MODULE_NOT_FOUND at boot without it — reported upstream).
if (has("dsh")) {
  const ROOT = dirname(MCP);
  const prof = join(homedir(), ".dsh", "profiles", "trantor");
  const pkgPath = join(prof, "package.json");
  const patchPath = join(prof, "cordis.patch.yml");
  const seatHooksPath = join(prof, "hooks.seat.json");
  // Pin the bridge packages to the INSTALLED dsh version. dsh releases ride the `next` dist-tag;
  // `latest` is stale (0.0.1-rc.x while the CLI is 0.1.0-rc.x), so an unpinned add installs an
  // ancient bridge whose peer range can't even see the modern protocol lib. Matching the CLI's own
  // version keeps one generation of the core in play (deepseek-harness discussions #3515/#3516).
  const dshVersion = (() => {
    try {
      const root = execSync("npm root -g", { encoding: "utf8" }).trim();
      return JSON.parse(readFileSync(join(root, "@deepseek-ai", "dsh", "package.json"), "utf8")).version || "next";
    } catch { return "next"; }
  })();
  const pkg = {
    name: "dsh-profile-trantor", private: true,
    dependencies: {
      "@deepseek-ai/dsh-hooks-claude-code": dshVersion,
      "@deepseek-ai/dsh-hook-protocol": dshVersion,
    },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
  };
  const patch = `# trantor — generated by \`trantor connect\` (edits survive: regenerate by deleting this file)
- insert:
    - id: trantor-cc-hooks
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: ${seatHooksPath}
        pluginRoot: ${ROOT}
    - id: trantor-relay
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: relay
        transport: stdio
        command: node
        args: ['${MCP}']
        env:
          RELAY_URL: !!js process.env.RELAY_URL ?? '${URL_}'
          RELAY_AGENT: !!js process.env.RELAY_AGENT ?? 'dsh'
          RELAY_PROJECT: !!js process.env.RELAY_PROJECT ?? ''
          RELAY_SESSION: !!js process.env.RELAY_SESSION ?? ''
`;
  const fresh = !existsSync(patchPath);
  if (!fresh) report("dsh", "already wired", prof);
  else {
    if (!DRY) {
      mkdirSync(prof, { recursive: true });
      // The seat runs the plugin's hooks MINUS SessionStart: the crew runner already owns
      // registration/announcement, and per-turn roster/catchup injection is wasted spend in a
      // fresh one-shot session (headless has no resume — every turn re-pays it). Note: an earlier
      // version of this comment blamed a dsh teardown crash on SessionStart; that was FALSE — the
      // crash was the duplicated-core install below, refuted by a clean-profile repro before we
      // reported upstream (deepseek-harness discussions #3515/#3516).
      try {
        const full = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
        const subset = Object.fromEntries(Object.entries(full.hooks || {}).filter(([k]) => k !== "SessionStart"));
        writeFileSync(seatHooksPath, JSON.stringify({
          description: "trantor dsh SEAT hooks — the plugin hooks.json minus SessionStart (regenerated by trantor connect; see bin/connect.mjs for why)",
          hooks: subset,
        }, null, 2) + "\n");
      } catch {}
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      writeFileSync(patchPath, patch);
      // the profile ROOT config. dsh self-heals a missing one, but the heal races the first boot
      // (observed: "Cannot read properties of undefined (reading 'prepare')" on the very first
      // seat turn, clean on every run after) — so write the complete profile up front.
      const rootPath = join(prof, "cordis.yml");
      if (!existsSync(rootPath)) writeFileSync(rootPath, "# dsh profile root — an empty entry list; the tree is composed from bundles + cordis.patch.yml.\n[]\n");
      // pnpm settings mirroring dsh's own profile template. autoInstallPeers:false is LOAD-BEARING:
      // an installer that pulls the bridge's peers drops a SECOND copy of dsh's core packages into
      // the profile, the loader mounts services from both module instances, and the first tool call
      // dies on ctx.tools[TOOL_RUNTIME_SCHEDULER] being undefined (observed: every turn that used
      // any tool crashed "reading 'prepare'"; tool-free turns worked).
      writeFileSync(join(prof, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
      // the two bridge packages must be importable from the profile's node_modules — via pnpm
      // (peers OFF, hoisted) like dsh's own template; npm needs --legacy-peer-deps for the same
      // no-duplicate-core guarantee.
      try {
        execSync(has("pnpm") ? "pnpm install --silent" : "npm install --legacy-peer-deps --no-fund --no-audit --loglevel=error",
          { cwd: prof, stdio: "ignore", timeout: 180000 });
      } catch { report("dsh", "profile written, but the install FAILED — run inside it: pnpm install (or npm install --legacy-peer-deps)"); }
    }
    if (!out.some(r => r.cli === "dsh")) report("dsh", "wired (profile created)", prof);
  }
}

const found = out.length;
console.log(`trantor connect${DRY ? " (dry run)" : ""} — hub: ${URL_}`);
for (const r of out) console.log(`  ${r.cli.padEnd(9)} ${r.status}${r.detail ? `  (${r.detail})` : ""}`);
if (!found) console.log("  no supported CLIs found on PATH (claude, codex, gemini, kimi, opencode, dsh)");
console.log(DRY ? "\nRun without --dry-run to apply." : "\nDone. New sessions of each CLI auto-join the bus.");
