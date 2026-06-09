#!/usr/bin/env node
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync } from "node:child_process";
const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const name = basename(project);
let summary = ""; process.stdin.setEncoding("utf8");
for await (const c of process.stdin) summary += c;
const dir = join(homedir(), ".agent-bus", "handoffs");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const stamp = (() => { try { return execSync("date +%s",{encoding:"utf8"}).trim(); } catch { return String(process.pid); } })();
let git=""; try { git = execSync("git -C "+JSON.stringify(project)+" status --short 2>/dev/null | head -30",{encoding:"utf8"}).trim(); } catch {}
const rec = { id:`${name}-${stamp}`, project, projectName:name, machine:hostname(), trigger:"manual-skill", stamp:Number(stamp)||0, summary:summary.trim()||"(empty)", gitStatus:git, consumed:false };
const file = join(dir, `${rec.id}.json`);
writeFileSync(file, JSON.stringify(rec,null,2));
console.log(`handoff saved: ${file}`);
