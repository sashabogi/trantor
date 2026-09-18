#!/usr/bin/env node
// trantor connect — wire every AI coding CLI on this machine to the bus, in one shot (idempotent;
// --dry-run touches nothing). Writes the one "relay" MCP entry into each CLI's own config format,
// with a timestamped .bak backup on first change. Claude Code rides the plugin: verified, not patched.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveProjectInfo, resolveHubInfo, gitRoot, writeProjectId, PROJECT_MARKER } from "../lib/project.mjs";

const DRY = process.argv.includes("--dry-run");
const MCP = join(dirname(dirname(fileURLToPath(import.meta.url))), "mcp.mjs");
// Connect-time truth stamped into every relay entry env (#7893): the project this checkout resolves
// to and the hub THAT project resolves to. Some CLIs spawn MCP with a scrubbed env where even `git`
// is missing, so the stamp is the belt; the worktree path rule in lib/project.mjs stays primary.
// Env wins in resolveHubInfo, so these keys are REFRESHED on every connect run — re-run after a pin change.
const PROJECT_INFO = resolveProjectInfo(process.cwd());
const PROJECT_AT_CONNECT = PROJECT_INFO.project;
const URL_ = resolveHubInfo(PROJECT_AT_CONNECT).url;
// Graft (github.com/NanoNets/context-graph-engine): local Tree-sitter dependency graph over MCP,
// wired next to `relay` so a seat locates code in one call; the graph refreshes itself per query
// and a project with no graft/ index simply returns empty tools. `graft build` seeds an index.
const GRAFT = (() => { try { return execSync("command -v graft", { encoding: "utf8", shell: "/bin/sh" }).trim(); } catch { return "graft"; } })();
const HAS_GRAFT = GRAFT !== "graft" || (() => { try { execSync("command -v graft", { stdio: "ignore", shell: "/bin/sh" }); return true; } catch { return false; } })();
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

// Two keys, refreshed by every connect run: agent identity and the hub. The PROJECT is never
// stamped: these configs are global to the CLI, and a seat of that CLI in another project would
// inherit the wrong board (RELAY_PROJECT outranks the worktree rule in resolveProject, #7893).
// A user-added env key survives the refresh merge.
const relayEnv = (agent) => ({ RELAY_AGENT: agent, RELAY_URL: URL_ });
// OpenCode hosts several differently-named seats. Its global MCP environment must not stamp all
// of them "opencode": ambient runner identity wins, while this fallback names a normal interactive
// OpenCode session that has no RELAY_AGENT/RELAY_SESSION of its own.
const hostedRelayEnv = (agent) => ({ RELAY_AGENT_FALLBACK: agent });

// ---- Claude Code: plugin handles it; verify only ----
if (has("claude")) {
  let st = "plugin not detected — run: claude plugin marketplace add sashabogi/trantor && claude plugin install trantor";
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    if (Object.keys(s.enabledPlugins || {}).some(k => k.startsWith("trantor@") || k.startsWith("agent-bus@"))) st = "plugin installed ✓";
  } catch {}
  report("claude", st);
}

// ---- Codex (TOML — append a missing relay section, refresh its env when it exists) ----
const tomlRelayEnv = `env = { RELAY_AGENT = "codex", RELAY_URL = "${URL_}" }`;
if (has("codex")) {
  const p = join(homedir(), ".codex", "config.toml");
  let cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (!cur.includes("[mcp_servers.relay]")) {
    const block = `\n# trantor — auto-registers each Codex session on the bus + adds relay_* tools\n# (env is REFRESHED by every \`trantor connect\`: agent + connect-time hub + project)\n[mcp_servers.relay]\ncommand = "node"\nargs = ["${MCP}"]\n${tomlRelayEnv}\n`;
    if (!DRY) { if (existsSync(p)) backup(p); else mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, cur + block); }
    report("codex", cur ? "wired" : "wired (new config)", p);
  } else {
    // Refresh the connect-written single-line `env = { ... }` inside the existing section; a
    // hand-rolled multi-line env table is left untouched (user customization wins) and is named.
    const start = cur.indexOf("[mcp_servers.relay]");
    const next = cur.indexOf("\n[", start + 1);
    const end = next === -1 ? cur.length : next + 1;
    const section = cur.slice(start, end);
    let refreshed = section, note = "already wired";
    if (/^env\s*=\s*\{.*\}\s*$/m.test(section)) refreshed = section.replace(/^env\s*=.*$/m, tomlRelayEnv);
    else if (!/^env\s*=/m.test(section)) refreshed = section.replace(/\n*$/, "\n") + tomlRelayEnv + "\n";
    else note = "relay env kept (custom shape) — refresh it by hand";
    if (refreshed !== section) {
      if (!DRY) { backup(p); writeFileSync(p, cur.slice(0, start) + refreshed + cur.slice(end)); }
      note = "relay env refreshed";
    }
    report("codex", note, p);
  }
  // graft alongside relay
  if (HAS_GRAFT) {
    const g = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (g.includes("[mcp_servers.graft]")) report("codex", "graft already wired");
    else {
      const gblock = `\n# trantor — Graft code-graph tools (graft_find_code/_find_all/_trace_calls/_file_api/_repo_map)\n[mcp_servers.graft]\ncommand = "${GRAFT}"\nargs = ["mcp"]\n`;
      if (!DRY) { if (existsSync(p)) backup(p); writeFileSync(p, g + gblock); }
      report("codex", "graft wired", p);
    }
  }
}

// ---- Gemini CLI ----  (relay entry env is REFRESHED: ||= kept an older connect's stale env forever)
if (has("gemini")) {
  const p = join(homedir(), ".gemini", "settings.json");
  report("gemini", patchJson(p, d => {
    d.mcpServers ||= {};
    d.mcpServers.relay ||= { command: "node", args: [MCP], env: {} };
    d.mcpServers.relay.env = { ...d.mcpServers.relay.env, ...relayEnv("gemini") };
    if (HAS_GRAFT) d.mcpServers.graft ||= { command: GRAFT, args: ["mcp"] };
  }), p);
}

// ---- Kimi CLI + kimi-code ----  (same refresh: the stale entry that caused #7893 was {RELAY_AGENT: kimi} only)
// kimi-code is a separate install reading ~/.kimi-code/mcp.json — wiring only the old file left the
// running kimi seat on a hard-coded stale hub (#7938). Same shape and stamp; the dir is detected by
// config.toml presence — existsSync only, the config itself is never read.
const kimiRelay = (cli, p) => report(cli, patchJson(p, d => {
  d.mcpServers ||= {};
  d.mcpServers.relay ||= { command: "node", args: [MCP], env: {} };
  d.mcpServers.relay.env = { ...d.mcpServers.relay.env, ...relayEnv("kimi") };
  if (HAS_GRAFT) d.mcpServers.graft ||= { command: GRAFT, args: ["mcp"] };
}), p);
const kimiPaths = [join(homedir(), ".kimi", "mcp.json"), join(homedir(), ".kimi-code", "mcp.json")];
const kimiWritten = new Set();
if (has("kimi")) { kimiRelay("kimi", kimiPaths[0]); kimiWritten.add(kimiPaths[0]); }
if (existsSync(join(homedir(), ".kimi-code", "config.toml"))) { kimiRelay("kimi-code", kimiPaths[1]); kimiWritten.add(kimiPaths[1]); }
// A kimi-family config this run did NOT write still names a hub of its own; if it disagrees with
// the pin, say so — one CLI of the pair would keep registering on a different bus (#7938).
for (const p of kimiPaths) {
  if (kimiWritten.has(p) || !existsSync(p)) continue;
  try {
    const u = JSON.parse(readFileSync(p, "utf8"))?.mcpServers?.relay?.env?.RELAY_URL;
    if (u && u !== URL_) report("kimi", `WARN: ${p} still points at ${u} — re-run connect or refresh it by hand`);
  } catch {}
}

// ---- OpenCode ----
// Deliberately NOT stamped with RELAY_URL/RELAY_PROJECT: OpenCode hosts several differently-named
// seats from one config, and a stamped project/hub would override every hosted seat's runner-provided
// env (the overlay bug the deletes below fix). Ambient runner env + RELAY_AGENT_FALLBACK stay in charge.
if (has("opencode")) {
  const p = join(homedir(), ".config", "opencode", "opencode.json");
  report("opencode", patchJson(p, d => {
    d.$schema ||= "https://opencode.ai/config.json";
    d.mcp ||= {};
    d.mcp.relay ||= { type: "local", command: ["node", MCP], enabled: true };
    if (HAS_GRAFT) d.mcp.graft ||= { type: "local", command: [GRAFT, "mcp"], enabled: true };
    d.mcp.relay.environment ||= {};
    // Migrate the old generated pin too: `||=` alone left RELAY_AGENT=opencode in every existing
    // config forever, where OpenCode overlaid it on the qwen/glm/deepseek runner environment.
    delete d.mcp.relay.environment.RELAY_AGENT;
    delete d.mcp.relay.environment.RELAY_SESSION;
    Object.assign(d.mcp.relay.environment, hostedRelayEnv("opencode"));
  }), p);
}

// ---- DeepSeek Harness (dsh): composes from PROFILES (~/.dsh/profiles/<name>), no single MCP config.
// We build a "trantor" profile mounting their Claude Code hooks bridge at OUR hooks.json plus their
// MCP client running our relay server with ambient RELAY_* identity; the bridge's protocol lib is
// declared explicitly — the rc package forgets it (ERR_MODULE_NOT_FOUND at boot).
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
  const patch = `# trantor — generated by \`trantor connect\` (connect rewrites this file only when it is missing a row; delete it to force a full regen)
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
${HAS_GRAFT ? `    - id: trantor-graft
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: graft
        transport: stdio
        command: ${GRAFT}
        args: ['mcp']
` : ""}`;
  // "a profile exists" is not "a profile is current": connect grows rows over time, and an existence
  // check short-circuits on a profile written by an older connect forever. The gate is CONTENT-based:
  // every row id this connect writes must already be in the patch, else regenerate (backed up).
  // Presence, not diff — user edits to rows that ARE there still win, like the JSON patches above.
  const expectedIds = [...patch.matchAll(/- id: (\S+)/g)].map(m => m[1]);
  const cur = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  const missing = expectedIds.filter(id => !cur.split("\n").some(l => l.trim() === `- id: ${id}`));
  const fresh = !existsSync(patchPath);
  if (!fresh && !missing.length) report("dsh", "already wired", prof);
  else if (!fresh) {
    if (!DRY) { backup(patchPath); writeFileSync(patchPath, patch); }
    report("dsh", `regenerated — was missing: ${missing.join(", ")}`, prof);
  } else {
    if (!DRY) {
      mkdirSync(prof, { recursive: true });
      // The seat runs the plugin's hooks MINUS SessionStart: the crew runner already owns
      // registration/announcement, and per-turn roster injection is wasted spend in a one-shot
      // session. (A dsh teardown crash was once blamed on SessionStart — FALSE: it was the
      // duplicated-core install below, refuted by clean-profile repro; deepseek-harness #3515/#3516.)
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
      // an installer that pulls the bridge's peers drops a SECOND copy of dsh's core into the
      // profile, both instances mount, and the first tool call dies on ctx.tools being undefined.
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
// The checkout records its id at connect time (#6724) when the name came from the directory, so a
// later rename carries the pin, board and sessions along. Never from RELAY_PROJECT or a seat
// worktree path: a badge must not stamp its name into somebody else's repo.
{
  const root = gitRoot(process.cwd());
  if (PROJECT_INFO.via === "marker") report("project", `id ${PROJECT_AT_CONNECT} already recorded in ${PROJECT_MARKER}`);
  else if (root && PROJECT_INFO.via === "git") {
    if (!DRY) writeProjectId(root, PROJECT_AT_CONNECT, "trantor connect");
    report("project", `id ${PROJECT_AT_CONNECT} recorded in ${PROJECT_MARKER} — commit it so worktrees and clones carry the identity`, root);
  }
}
console.log(`trantor connect${DRY ? " (dry run)" : ""} — project: ${PROJECT_AT_CONNECT}, hub: ${URL_}`);
for (const r of out) console.log(`  ${r.cli.padEnd(9)} ${r.status}${r.detail ? `  (${r.detail})` : ""}`);
if (!found) console.log("  no supported CLIs found on PATH (claude, codex, gemini, kimi, opencode, dsh)");
console.log(DRY ? "\nRun without --dry-run to apply." : "\nDone. New sessions of each CLI auto-join the bus.");
