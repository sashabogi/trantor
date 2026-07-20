#!/usr/bin/env node
// trantor — the command. Thin dispatcher over the toolkit so a global npm install
// gives you everything:  trantor setup | doctor | connect | profile | advise | up | down | hub | ui
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const [, , cmd, ...args] = process.argv;
const run = (file, runner = process.execPath) => {
  const child = spawn(runner, [join(ROOT, file), ...args], { stdio: "inherit", cwd: process.cwd() });
  child.on("exit", (c) => process.exit(c ?? 0));
};

switch (cmd) {
  case "setup":   run("deploy/setup.sh", "/bin/bash"); break;
  case "doctor":  run("bin/doctor.mjs"); break;
  case "connect": run("bin/connect.mjs"); break;
  case "profile": run("bin/profile.mjs"); break;
  case "provider": case "providers": run("bin/provider.mjs"); break;
  case "models": run("bin/models.mjs"); break;
  case "advise":  run("bin/advise.mjs"); break;
  case "verify":  run("bin/crew-verify.mjs"); break;
  case "up":      process.argv.splice(2, 1); spawn("/bin/bash", [join(ROOT, "bin/crew.sh"), "up", ...args], { stdio: "inherit", cwd: process.cwd() }).on("exit", c => process.exit(c ?? 0)); break;
  case "down":    spawn("/bin/bash", [join(ROOT, "bin/crew.sh"), "down", ...args], { stdio: "inherit", cwd: process.cwd() }).on("exit", c => process.exit(c ?? 0)); break;
  case "swap":    spawn("/bin/bash", [join(ROOT, "bin/crew.sh"), "swap", ...args], { stdio: "inherit", cwd: process.cwd() }).on("exit", c => process.exit(c ?? 0)); break;
  case "hub":     run("hub.mjs"); break;
  case "watch":   run("bin/relay-watch.mjs"); break;
  case "catchup": run("bin/catchup.mjs"); break;
  case "agents":  run("bin/agents.mjs"); break;
  case "gates":   run("bin/gates.mjs"); break;
  case "backfill": run("bin/git-backfill.mjs"); break;
  case "sweep": run("bin/sweep.mjs"); break;
  case "init-hooks": run("bin/init-hooks.mjs"); break;
  case "balances": case "balance": case "credits": run("bin/balances.mjs"); break;
  case "recost": run("bin/recost.mjs"); break;
  case "handoff": run("bin/baton.mjs"); break;
  case "ui": {
    let url = "http://127.0.0.1:4477";
    try { url = JSON.parse(readFileSync(join(process.env.HOME || "", ".agent-bus", "config.json"), "utf8")).url || url; } catch {}
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    console.log(`dashboard → ${url}`);
    break;
  }
  case "version": case "-v": case "--version":
    console.log(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version); break;
  default:
    console.log(`trantor — the hub-world for AI agent crews

  trantor setup       one-shot install: hub as an always-on service + config + CLI wiring + doctor
  trantor doctor      where do I stand? hub/plugin/CLIs/auth/keys/profile, with copy-paste fixes
  trantor connect     (re)wire every installed AI CLI to the bus
  trantor profile     declare your plans:  trantor profile set claude=max codex=plus deepseek=api
  trantor provider    bring ANY model (BYOM): list seats · add <name> --key … · remove <name>
  trantor models      browse live models behind each seat + the router's pick per difficulty
  trantor up …        spawn a crew here:   trantor up codex kimi deepseek:deepseek glm:zai-coding-plan
  trantor down        tear the crew down (kills processes, closes windows, no dialogs)
  trantor ui          open the live dashboard (board + flow views)
  trantor catchup     "where are we?" — the continuous board + git, with a synthesized brief
  trantor agents      what this session's sub-agents did (task · returned? · files written · survived on disk) — [<sessionId>] [--json]
  trantor gates       verification gates: "must verify before shipping" claims that survive handoffs — [--all] [--json]
  trantor backfill    card past GIT work onto the board (solo commits that were never carded) — [--since "14 days ago"] [--dry-run]
  trantor init-hooks  install a git post-commit hook so EVERY commit auto-cards on the board (reliable solo-work backstop) — [--uninstall]
  trantor balances    how much credit is left on each CONFIGURED provider (from your profile) — refill before you stall — [--json]
  trantor recost      recompute sub-agent notional cost from on-disk transcripts + reseed the board (repair after upgrade) — [--dry-run]
  trantor handoff     finish this session NOW: write a handoff, open a fresh session that takes over, and close this one (manual baton)
  trantor advise      ask the Advisor directly (JSON on stdin; --demo to see it)
  trantor hub         run the hub in the foreground (setup installs it as a service instead)
  trantor watch       live bus feed in the terminal

Claude Code plugin (the orchestrator side):
  claude plugin marketplace add sashabogi/trantor && claude plugin install trantor
Docs: https://github.com/sashabogi/trantor`);
}
