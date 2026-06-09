#!/usr/bin/env node
// agent-bus PreCompact hook — fires right before Claude Code compacts a full
// context window. Instead of (just) compacting, it writes a rich HANDOFF so you can
// open a FRESH session that takes over with a new full window. The SessionStart hook
// detects the pending handoff and loads it.
//
// Handoff generation: if `scrooge` is on PATH, it summarizes the recent transcript
// into a structured handoff cheaply; otherwise it falls back to a raw transcript tail.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HANDOFF_DIR = join(homedir(), ".agent-bus", "handoffs");

function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 100); });
}

// Pull readable recent conversation text from a Claude Code transcript JSONL.
function recentTranscript(path, maxChars = 16000) {
  try {
    const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const turns = [];
    for (const r of rows) {
      if (!(r.type === "user" || r.type === "assistant") || !r.message) continue;
      const c = r.message.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.filter(b => b?.type === "text").map(b => b.text).join("\n");
      if (text.trim() && !text.startsWith("<task-notification") && !text.startsWith("<command")) {
        turns.push(`### ${r.type.toUpperCase()}\n${text.slice(0, 2000)}`);
      }
    }
    let out = turns.join("\n\n");
    if (out.length > maxChars) out = out.slice(out.length - maxChars); // keep the most recent
    return out;
  } catch { return ""; }
}

function haveScrooge() { try { execSync("command -v scrooge", { stdio: "ignore" }); return true; } catch { return false; } }

function summarize(convo) {
  const sys = "You are writing a SESSION HANDOFF so a fresh Claude Code session can take over without losing context. From the conversation, produce a concise but complete markdown handoff with these sections: TASK (what we're doing + the goal), STATE (done / in-progress), KEY DECISIONS, OPEN THREADS & NEXT STEPS (concrete actions), KEY FILES & locations (exact paths). Be specific. Do not pad.";
  if (haveScrooge()) {
    try {
      return execSync(`scrooge -t summarize -d medium --system ${JSON.stringify(sys)}`, {
        input: convo, encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1024 * 1024,
      }).trim();
    } catch (e) { process.stderr.write(`[agent-bus] scrooge summarize failed: ${e?.message}\n`); }
  }
  // fallback: raw recent tail
  return `*(no summarizer available — raw recent transcript tail)*\n\n${convo.slice(-6000)}`;
}

try {
  const input = JSON.parse((await readStdin()) || "{}");
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectName = basename(projectDir);
  const transcript = input.transcript_path || "";
  const trigger = input.trigger || "auto";

  const convo = transcript && existsSync(transcript) ? recentTranscript(transcript) : "";
  const summary = convo ? summarize(convo) : "*(no transcript available to summarize)*";

  let gitStatus = "";
  try { gitStatus = execSync("git -C " + JSON.stringify(projectDir) + " status --short 2>/dev/null | head -30", { encoding: "utf8" }).trim(); } catch {}

  if (!existsSync(HANDOFF_DIR)) mkdirSync(HANDOFF_DIR, { recursive: true });
  const stamp = (() => { try { return execSync("date +%s", { encoding: "utf8" }).trim(); } catch { return String(process.pid); } })();

  const record = {
    id: `${projectName}-${stamp}`,
    project: projectDir, projectName,
    machine: hostname(),
    session_id: input.session_id || "",
    trigger, transcript_path: transcript,
    stamp: Number(stamp) || 0,
    summary,
    gitStatus,
    consumed: false,
  };
  const file = join(HANDOFF_DIR, `${record.id}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  process.stderr.write(`[agent-bus] handoff written: ${file} (trigger=${trigger})\n`);

  // best-effort: ping the relay hub so other sessions/machines know a handoff is ready
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
    const url = process.env.RELAY_URL || (existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")).url : "") || "http://127.0.0.1:4477";
    await fetch(`${url}/send`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: `${hostname()}:${projectName}`, to: "all", text: `📋 Handoff ready for ${projectName} — open a fresh session here to take over (id ${record.id}).` }),
      signal: AbortSignal.timeout(2000) }).catch(() => {});
  } catch {}

  // OPT-IN: on macOS, if config.autoHandoffPrompt is true, ask the user (with a timeout,
  // default = yes) whether to spawn a FRESH same-agent session that takes over via the
  // handoff. Detached so it never blocks compaction. Off by default.
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
    const conf = existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : {};
    if (conf.autoHandoffPrompt && process.platform === "darwin") {
      const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "handoff-prompt.sh");
      if (existsSync(script)) {
        const child = spawn("/bin/bash", [script, projectDir, String(conf.handoffPromptTimeout || 25)], { detached: true, stdio: "ignore" });
        child.unref();
        process.stderr.write(`[agent-bus] handoff prompt launched (opt-in)\n`);
      }
    }
  } catch {}
} catch (err) {
  process.stderr.write(`[agent-bus] precompact error: ${err?.message || err}\n`);
}
process.stdout.write("{}");
process.exit(0);
