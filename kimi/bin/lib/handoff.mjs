// trantor/kimi — kimi-specific baton-pass glue for kimi/bin/*. After the dialect-bridge de-fork
// (docs/KIMI-BRIDGE-CONTRACT.md, P2) all hook logic lives in the canonical hooks/**; what remains
// here is ONLY what cannot be canonical: the kimi wire.jsonl session layout (sub-agent liveness)
// and spawning a fresh `kimi` session (the canonical spawnFresh hardcodes `claude`).
// Everything else (open-session.sh, handoff-prompt.sh) is the canonical bin/ script.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));            // <plugin>/kimi/bin/lib
const KIMI_BIN = join(HERE, "..");                               // <plugin>/kimi/bin
const PLUGIN_BIN = join(HERE, "..", "..", "..", "bin");          // <plugin>/bin (canonical)

export function readConfig() {
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
    return existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : {};
  } catch { return {}; }
}

// ---- in-flight guard (kimi session layout) ----------------------------------
// True when this session has live sub-agents: any agents/<not-main>/wire.jsonl written within
// `withinMs`. The baton-close ABORTS while sub-agents run (incident 2026-06-21).
export function subagentsActive(wirePath, withinMs = 90_000) {
  try {
    if (!wirePath) return false;
    const agentsDir = dirname(dirname(wirePath));       // <session>/agents
    const cutoff = Date.now() - withinMs;
    for (const a of readdirSync(agentsDir)) {
      if (a === "main") continue;
      try { if (statSync(join(agentsDir, a, "wire.jsonl")).mtimeMs >= cutoff) return true; } catch {}
    }
    return false;
  } catch { return false; }
}

// --- original window resolution (macOS Terminal.app) --------------------------
export function controllingTty() {
  for (const pid of [process.pid, process.ppid, getPpid(process.ppid)]) {
    if (!pid) continue;
    try { const t = execSync(`ps -o tty= -p ${pid}`, { encoding: "utf8" }).trim(); if (t && t !== "??" && t !== "?") return "/dev/" + t; } catch {}
  }
  return "";
}
function getPpid(pid) { if (!pid) return 0; try { return Number(execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8" }).trim()) || 0; } catch { return 0; } }

export function terminalWindowForTty(tty) {
  if (process.platform !== "darwin" || !tty) return "";
  const osa = `tell application "Terminal"
    repeat with w in windows
      try
        if (tty of selected tab of w) is "${tty}" then return (id of w) as string
      end try
    end repeat
    return ""
  end tell`;
  // Multi-line script via stdin, never -e (see hooks/lib/handoff.mjs for the incident note).
  try { return execSync(`osascript`, { input: osa, encoding: "utf8", timeout: 3000 }).trim(); } catch { return ""; }
}

export function frontTerminalWindow() {
  if (process.platform !== "darwin") return { id: "", tty: "" };
  try {
    const out = execSync(`osascript -e ${JSON.stringify(`tell application "Terminal" to return (id of front window as string) & "|" & (tty of selected tab of front window)`)}`,
      { encoding: "utf8", timeout: 3000 }).trim();
    const [id, tty] = out.split("|"); return { id: id || "", tty: tty || "" };
  } catch { return { id: "", tty: "" }; }
}

// MUST be called BEFORE spawning the fresh session (see hooks/lib/handoff.mjs — ordering is
// load-bearing; reversing it is the "successor closes ITSELF" bug).
export function resolveOriginalWindow() {
  let tty = controllingTty(), windowId = tty ? terminalWindowForTty(tty) : "";
  if (!windowId) { const f = frontTerminalWindow(); windowId = f.id; tty = f.tty; }
  return { windowId, tty };
}

// --- fresh-session spawn (kimi) ----------------------------------------------
// Kimi Code has no positional-prompt interactive mode (-p is non-interactive and exits), so the
// baton opens a plain interactive `kimi`: its SessionStart hook claims the pending handoff.
export const RECAP_CMD = "kimi";

export function spawnFresh(projectDir) {
  try {
    if (process.platform !== "darwin" || process.env.TRANTOR_NO_HANDOFF_SPAWN === "1") return false;
    const script = join(PLUGIN_BIN, "open-session.sh");   // canonical script — kimi's was identical
    if (!existsSync(script)) return false;
    const child = spawn("/bin/bash", [script, projectDir, RECAP_CMD], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch { return false; }
}

// Arm the baton-close watcher (kimi variant — kimi/bin/baton-close.mjs reads kimi wire.jsonl).
// Same safety contract as canonical: auto-close strictly opt-in (config.autoCloseOriginal:true).
export function armBatonClose(handoffFile, originalWindowId, originalTty, conf = readConfig(), { auto = false } = {}) {
  try {
    if (process.platform !== "darwin" || !originalWindowId) return false;
    if (process.env.TRANTOR_NO_BATON_CLOSE === "1" || conf.batonClose === false) return false;
    if (auto && conf.autoCloseOriginal !== true) return false;
    const closer = join(KIMI_BIN, "baton-close.mjs");
    if (!existsSync(closer)) return false;
    const child = spawn(process.execPath, [closer, handoffFile, String(originalWindowId), originalTty || ""], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch { return false; }
}

// MANUAL one-command baton (ordering is load-bearing — see hooks/lib/handoff.mjs).
export function spawnBaton({ projectDir, handoffFile, conf = readConfig(),
  _resolveWindow = resolveOriginalWindow, _spawnFresh = spawnFresh, _armClose = armBatonClose }) {
  const { windowId, tty } = _resolveWindow();
  const spawned = _spawnFresh(projectDir);
  if (!spawned) return { spawned: false, armed: false, windowId: "" };
  const armed = windowId ? _armClose(handoffFile, windowId, tty, conf) : false;
  return { spawned, armed, windowId };
}
