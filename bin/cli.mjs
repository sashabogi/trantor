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
  case "hub": {
    const sub = args[0];
    // Per-project hub routing (TDD §12.1): a project lives on exactly ONE hub; codependent
    // projects MUST share one. The mapping lives in ~/.agent-bus/config.json `hubs`.
    if (sub === "list" || sub === "set" || sub === "unset") {
      const { readConfig, setProjectHub, unsetProjectHub, resolveProject, resolveHub, DEFAULT_HUB_URL } = await import(join(ROOT, "lib/project.mjs"));
      if (sub === "list") {
        const cfg = readConfig();
        const here = resolveProject();
        console.log(`global default: ${cfg.url || DEFAULT_HUB_URL}${cfg.url ? "" : " (built-in)"}`);
        const hubs = cfg.hubs && typeof cfg.hubs === "object" ? Object.entries(cfg.hubs) : [];
        if (!hubs.length) console.log("no per-project pins — every project uses the global default");
        for (const [p, u] of hubs) console.log(`${p === here ? "*" : " "} ${p} → ${u}`);
        console.log(`effective hub for this project (${here}): ${resolveHub(here)}`);
      } else if (sub === "set") {
        const [, project, url] = args;
        if (!project || !url) { console.error("usage: trantor hub set <project> <url>"); process.exit(1); }
        try { setProjectHub(project, url); }
        catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
        console.log(`${project} → ${String(url).replace(/\/+$/, "")} (pinned in ~/.agent-bus/config.json)`);
      } else {
        const project = args[1];
        if (!project) { console.error("usage: trantor hub unset <project>"); process.exit(1); }
        const had = unsetProjectHub(project);
        console.log(had ? `${project} unpinned — falls back to the global default` : `${project} had no per-project pin`);
      }
      break;
    }
    run("hub.mjs"); break;
  }
  case "watch":   run("bin/relay-watch.mjs"); break;
  case "catchup": run("bin/catchup.mjs"); break;
  case "agents":  run("bin/agents.mjs"); break;
  case "gates":   run("bin/gates.mjs"); break;
  case "backfill": run("bin/git-backfill.mjs"); break;
  case "sweep": run("bin/sweep.mjs"); break;
  case "reconcile": run("bin/reconcile.mjs"); break;
  case "init-hooks": run("bin/init-hooks.mjs"); break;
  case "balances": case "balance": case "credits": run("bin/balances.mjs"); break;
  case "recost": run("bin/recost.mjs"); break;
  case "handoff": run("bin/baton.mjs"); break;
  case "adopt": run("bin/adopt.mjs"); break;
  case "summarize": run("bin/summarize.mjs"); break;
  case "identity": {
    const { load, publicView, generate, keyPath } = await import(join(ROOT, "lib/identity.mjs"));
    const sub = args[0], name = args[1] || "human";
    if (sub === "show") {
      const id = load(name);
      if (!id) { console.error(`No identity found for "${name}".`); process.exit(1); }
      console.log(JSON.stringify(publicView(id), null, 2));
    } else if (sub === "rotate") {
      const { writeFileSync, chmodSync, renameSync, mkdirSync } = await import("node:fs");
      const { randomBytes } = await import("node:crypto");
      const { pubkey, privkey } = generate();
      const nId = { name: String(name), kind: "human", pubkey, privkey, createdAt: Date.now() };
      const f = keyPath(name);
      mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 });
      try { chmodSync(join(f, ".."), 0o700); } catch {}
      const tmp = `${f}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(nId), { mode: 0o600 });
      renameSync(tmp, f);
      chmodSync(f, 0o600);
      console.log(JSON.stringify({ name: String(name), pubkey, rotated: true }, null, 2));
    } else {
      console.error("usage: trantor identity <show|rotate> [name]");
      process.exit(1);
    }
    break;
  }
  case "invite": {
    const { loadOrCreate, signRequest } = await import(join(ROOT, "lib/identity.mjs"));
    const nameIdx = args.indexOf("--name"), scopeIdx = args.indexOf("--scope");
    const name = nameIdx >= 0 ? args[nameIdx + 1] : "";
    const scopeRaw = scopeIdx >= 0 ? (args[scopeIdx + 1] || "") : "";
    if (!name || !scopeRaw) { console.error("usage: trantor invite --name <name> --scope <project>:<role>"); process.exit(1); }
    const [project, role = "write"] = scopeRaw.split(":");
    let hub = "http://127.0.0.1:4477";
    try { hub = JSON.parse(readFileSync(join(process.env.HOME || "", ".agent-bus", "config.json"), "utf8")).url || hub; } catch {}
    const id = loadOrCreate("admin", "human");
    const payload = { scopes: [{ project, role }], ttlSec: 86400 };
    const body = JSON.stringify(payload);
    const sig = signRequest(id, { method: "POST", path: "/invite", body });
    const r = await fetch(`${hub}/invite`, { method: "POST", headers: { "content-type": "application/json", ...sig }, body });
    const j = await r.json();
    if (r.ok) console.log(`Invite token: ${j.token}\nShare this with the new member: trantor enroll ${j.token}`);
    else console.error(`Invite failed: ${j.error || r.statusText}`);
    break;
  }
  case "enroll": {
    const token = args[0];
    if (!token) { console.error("usage: trantor enroll <token>"); process.exit(1); }
    let hub = "http://127.0.0.1:4477";
    try { hub = JSON.parse(readFileSync(join(process.env.HOME || "", ".agent-bus", "config.json"), "utf8")).url || hub; } catch {}
    const { loadOrCreate, signRequest } = await import(join(ROOT, "lib/identity.mjs"));
    const id = loadOrCreate("human", "human");
    const payload = { token, name: "human", pubkey: id.pubkey, kind: "human" };
    const body = JSON.stringify(payload);
    const sig = signRequest(id, { method: "POST", path: "/enroll", body });
    const r = await fetch(`${hub}/enroll`, { method: "POST", headers: { "content-type": "application/json", ...sig }, body });
    const j = await r.json();
    if (r.ok) console.log(`Enrolled! Pubkey: ${id.pubkey.slice(0, 16)}…`);
    else console.error(`Enrollment failed: ${j.error || r.statusText}`);
    break;
  }
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
                      …or manage per-project hub pins: hub list · hub set <project> <url> · hub unset <project>
  trantor watch       live bus feed in the terminal

Claude Code plugin (the orchestrator side):
  claude plugin marketplace add sashabogi/trantor && claude plugin install trantor
Docs: https://github.com/sashabogi/trantor`);
}
