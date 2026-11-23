// #13920: machine health heartbeat payload — one source for the shape the runner posts and the
// hub validates. Pure functions over an os-like module so tests feed a fake os (no /proc reads,
// no shell-outs); the runner passes Node's own os functions.
import { cpus, freemem, loadavg, totalmem } from "node:os";

export const HEALTH_BEAT_MS = 30_000;   // heartbeat cadence; three beats fit the stale window
export const HEALTH_STALE_MS = Number(process.env.RELAY_HEALTH_STALE_MS || 90_000);

// cpuPct is the 1-min loadavg over the core count, as a percent — it CAN exceed 100 (a machine
// oversubscribed past its cores must not read as a capped, calm 100). Memory is used/total bytes;
// "used" is total minus free, the same arithmetic every system monitor shows.
export function healthPayload(osLike, machine, now = Date.now()) {
  const cores = Math.max(1, (Array.isArray(osLike.cpus()) ? osLike.cpus() : []).length);
  const load = Number(osLike.loadavg()?.[0]);
  const total = Number(osLike.totalmem());
  const free = Number(osLike.freemem());
  const cpuPct = Number.isFinite(load) && load >= 0 ? Math.round((load / cores) * 100) : null;
  return {
    machine: String(machine || ""),
    cpuPct,
    memUsed: Number.isFinite(total) && Number.isFinite(free) ? Math.max(0, total - free) : null,
    memTotal: Number.isFinite(total) ? total : null,
    ts: now(),
  };
}

export const defaultOs = { cpus, freemem, loadavg, totalmem };
