import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cacheDir = busDir => join(busDir || process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"), "overseer-levels");
const cacheFile = ({ project, hub, busDir }) => join(cacheDir(busDir), createHash("sha256").update(JSON.stringify([hub, project])).digest("hex") + ".json");

export function readOverseerLevel(context) {
  try {
    const { level, ts } = JSON.parse(readFileSync(cacheFile(context), "utf8"));
    const age = Date.now() - ts;
    return [1, 2, 3, 4].includes(level) && age >= 0 && age < 60_000 ? level : null;
  } catch { return null; }
}

export function writeOverseerLevel(context, level) {
  if (![1, 2, 3, 4].includes(level)) return;
  try {
    mkdirSync(cacheDir(context.busDir), { recursive: true });
    writeFileSync(cacheFile(context), JSON.stringify({ level, ts: Date.now() }));
  } catch { /* A cache write failure must not affect the edit decision. */ }
}
