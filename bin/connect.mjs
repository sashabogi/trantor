#!/usr/bin/env node
// agent-bus connect — wire every AI coding CLI on this machine to the bus, in one shot.
//
//   node bin/connect.mjs            # detect installed CLIs, patch each one's MCP config (idempotent)
//   node bin/connect.mjs --dry-run  # show what would change, touch nothing
//
// Each CLI keeps its own MCP config file/format; this writes the one "relay" entry into each
// (with a timestamped .bak backup the first time it changes a file). Claude Code is handled by
// the plugin (claude plugin install agent-bus), so it's only verified here, not patched.
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

const relayEnv = (agent) => ({ RELAY_URL: URL_, RELAY_AGENT: agent });

// ---- Claude Code: plugin handles it; verify only ----
if (has("claude")) {
  let st = "plugin not detected — run: claude plugin marketplace add sashabogi/trantor && claude plugin install agent-bus";
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    if (Object.keys(s.enabledPlugins || {}).some(k => k.startsWith("agent-bus@"))) st = "plugin installed ✓";
  } catch {}
  report("claude", st);
}

// ---- Codex (TOML append — no TOML lib needed) ----
if (has("codex")) {
  const p = join(homedir(), ".codex", "config.toml");
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (cur.includes("[mcp_servers.relay]")) report("codex", "already wired");
  else {
    const block = `\n# agent-bus — auto-registers each Codex session on the bus + adds relay_* tools\n[mcp_servers.relay]\ncommand = "node"\nargs = ["${MCP}"]\nenv = { RELAY_URL = "${URL_}", RELAY_AGENT = "codex" }\n`;
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

const found = out.length;
console.log(`agent-bus connect${DRY ? " (dry run)" : ""} — hub: ${URL_}`);
for (const r of out) console.log(`  ${r.cli.padEnd(9)} ${r.status}${r.detail ? `  (${r.detail})` : ""}`);
if (!found) console.log("  no supported CLIs found on PATH (claude, codex, gemini, kimi, opencode)");
console.log(DRY ? "\nRun without --dry-run to apply." : "\nDone. New sessions of each CLI auto-join the bus.");
