// #9778: the stale-resource janitor's docker half. Snapshots, diffs and stops, with the docker
// exec injectable so a drill never starts a real container. Stop means `docker stop` only —
// never rm, never volumes: a stopped stack keeps its data and is one `start` away from back.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const dockerExec = (args) =>
  spawnSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 });

// `docker ps --format '{{.ID}} {{.Names}}'` → [{id, name}]. null = docker absent or the daemon
// errored (the caller skips silently, by contract); [] = docker up, nothing running.
export function listContainers(exec = dockerExec) {
  let r;
  try { r = exec(["ps", "--format", "{{.ID}} {{.Names}}"]); } catch { return null; }
  if (!r || r.error || r.status !== 0) return null;
  return String(r.stdout || "").split("\n").map(l => l.trim()).filter(Boolean).map(l => {
    const sp = l.indexOf(" ");
    return sp < 0 ? { id: l, name: l } : { id: l.slice(0, sp), name: l.slice(sp + 1).trim() };
  });
}

// Containers present in `after` that were not in `before`, by id. A null snapshot (docker was
// absent on either side) diffs to nothing — we never accuse a turn we could not observe.
export function newContainers(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const seen = new Set(before.map(c => c.id));
  return after.filter(c => !seen.has(c.id));
}

// One state file per seat, so a card close, a park or `trantor down <seat>` can still stop what
// the seat started even after its runner is gone.
export function statePathFor(agent, project, dir = join(homedir(), ".agent-bus")) {
  return join(dir, `docker-${agent}-${project}.json`);
}

export function loadContainers(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const cards = j?.cards instanceof Object ? j.cards : {};
    return { cards };
  } catch { return { cards: {} }; }
}

function saveContainers(path, state) {
  try {
    if (!Object.values(state.cards).some(list => Array.isArray(list) && list.length)) {
      try { unlinkSync(path); } catch {}
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {}
}

// Record containers a turn created against the seat's card (0 = no card bound). Dedupes by id:
// a container two turns both saw new is recorded once. Returns the rows newly added.
export function recordContainers({ path, card, containers, now = Date.now() }) {
  if (!containers?.length) return [];
  const state = loadContainers(path);
  const key = String(card || 0);
  const have = new Set((state.cards[key] || []).map(c => c.id));
  const fresh = containers.filter(c => c.id && !have.has(c.id)).map(c => ({ id: c.id, name: c.name || c.id, at: now }));
  if (!fresh.length) return [];
  state.cards[key] = [...(state.cards[key] || []), ...fresh];
  saveContainers(path, state);
  return fresh;
}

// `docker stop <ids>` — the ONLY verb this module ever runs. unavailable = docker is absent or
// wedged: the caller stays silent and the record stands for the next sweep.
export function stopContainers({ exec = dockerExec, containers } = {}) {
  const ids = (containers || []).map(c => c.id).filter(Boolean);
  if (!ids.length) return { unavailable: false, stopped: [], failed: [] };
  let r;
  try { r = exec(["stop", ...ids]); } catch { return { unavailable: true, stopped: [], failed: [] }; }
  if (!r || r.error) return { unavailable: true, stopped: [], failed: [] };
  if (r.status !== 0) return { unavailable: false, stopped: [], failed: containers.map(c => c.name || c.id) };
  const stoppedIds = new Set(String(r.stdout || "").split("\n").map(l => l.trim()).filter(Boolean));
  const stopped = [], failed = [];
  for (const c of containers) (stoppedIds.has(c.id) ? stopped : failed).push(c.name || c.id);
  return { unavailable: false, stopped, failed };
}

// Stop everything recorded for one card (or every card when card is undefined) and forget what
// stopped; what could not be stopped stays recorded so the next sweep tries again.
export function sweep({ path, exec = dockerExec, card } = {}) {
  const state = loadContainers(path);
  const keys = card === undefined ? Object.keys(state.cards) : [String(card)];
  const targets = keys.flatMap(k => (state.cards[k] || []));
  if (!targets.length) return { skipped: false, stopped: [], failed: [] };
  const r = stopContainers({ exec, containers: targets });
  if (r.unavailable) return { skipped: true, stopped: [], failed: [] };
  for (const k of keys) {
    state.cards[k] = (state.cards[k] || []).filter(c => !r.stopped.includes(c.name || c.id));
    if (!state.cards[k].length) delete state.cards[k];
  }
  saveContainers(path, state);
  return { skipped: false, stopped: r.stopped, failed: r.failed };
}
