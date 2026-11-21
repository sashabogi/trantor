import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ACTIVE_MS = 15_000;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

export function readHeavyGateWait(dir, now = Date.now()) {
  let totalMs = 0, waiting = false;
  if (!dir) return { totalMs, waiting };
  let names = [];
  try { names = readdirSync(dir).filter(name => name.endsWith(".json")).slice(0, 256); } catch { return { totalMs, waiting }; }
  for (const name of names) {
    let row;
    try { row = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
    const recorded = Number(row?.totalMs);
    const updatedAt = Number(row?.updatedAt);
    if (!Number.isFinite(recorded) || recorded < 0 || !Number.isFinite(updatedAt)) continue;
    const active = row.waiting === true && now - updatedAt <= ACTIVE_MS && alive(Number(row.pid));
    totalMs += recorded + (active ? Math.max(0, now - updatedAt) : 0);
    if (active) waiting = true;
  }
  return { totalMs, waiting };
}
