// trantor — DECLARED SEATS: which project belongs in which directory, and whether it is running.
// A reboot reopens every window in $HOME; a declared seat can be put back, and nothing here guesses.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, writeConfigPublic, resolveProject, resolveHubInfo } from "./project.mjs";
import { asRecord, asString } from "./decode.mjs";

// ── the registry ────────────────────────────────────────────────────────────────
// config.json gains `seats: { <project>: { dir } }`. Same file as `hubs`, same shape of decision:
// a deliberate operator statement, not an inference.
export function readSeats() {
  try {
    const s = asRecord(readConfig()?.seats);
    if (!s) return {};
    const out = {};
    for (const [p, v] of Object.entries(s)) {
      const dir = asString(v) ?? asRecord(v)?.dir;
      const agent = asString(asRecord(v)?.agent) || "claude";
      if (asString(dir)) out[p] = { dir, agent };
    }
    return out;
  } catch { return {}; }
}

export function declareSeat(project, dir, agent = "claude") {
  if (!asString(project)) throw new Error("project required");
  const abs = resolve(dir || process.cwd());
  if (!existsSync(abs)) throw new Error(`directory does not exist: ${abs}`);
  const cfg = readConfig();
  const seats = { ...(asRecord(cfg.seats) ?? {}) };
  seats[project] = { dir: abs, agent };
  cfg.seats = seats;
  writeConfigPublic(cfg);
  return { project, dir: abs, agent };
}

export function undeclareSeat(project) {
  const cfg = readConfig();
  const seats = asRecord(cfg.seats);
  if (!seats || !(project in seats)) return false;
  delete seats[project];
  if (!Object.keys(seats).length) delete cfg.seats;
  writeConfigPublic(cfg);
  return true;
}

// ── liveness ────────────────────────────────────────────────────────────────────
// A seat is live when a real process is STANDING IN ITS DIRECTORY (ps + lsof, bounded, fail-soft),
// never by the hub's presence list. Two blind spots read as UNKNOWN, never missing (#8716): a
// process whose cwd lsof could not read could be standing in any seat, and so could a dark herdr.
export function liveAgentDirs(binaries = ["claude", "codex", "opencode"]) {
  const out = [];   // [{ pid, comm, cwd }]
  let rows = "";
  try {
    rows = execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 4000 });
  } catch { return out; }
  const self = String(process.pid);
  for (const line of rows.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, comm] = m;
    if (pid === self) continue;
    const base = comm.split("/").pop();
    if (!binaries.includes(base)) continue;
    let cwd = null;
    try {
      const fn = execFileSync("/usr/sbin/lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"],
        { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
      const hit = fn.split("\n").find(l => l.startsWith("n"));
      if (hit) cwd = hit.slice(1);
    } catch { /* the process died, or lsof starved: the cwd is UNKNOWN, never live, never absent */ }
    out.push({ pid: Number(pid), comm: base, cwd });
  }
  return out;
}

// herdr restores its panes at boot, before any Terminal window could exist, so a herdr agent
// standing in the seat's directory holds the seat exactly as a bare process would (#8716).
// Installed but unreachable reads { installed: true, ok: false } — uncertainty, not absence; not
// installed is SKIP: the probe holds nothing and blinds nothing.
export function herdrAgents(exec = execFileSync) {
  let bin = "";
  try { bin = exec("/usr/bin/which", ["herdr"], { encoding: "utf8", timeout: 4000 }).trim(); } catch { return { installed: false, ok: true, agents: [] }; }
  if (!bin) return { installed: false, ok: true, agents: [] };
  try {
    const parsed = JSON.parse(exec(bin, ["agent", "list"], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] }));
    const rows = asRecord(parsed?.result)?.agents;
    if (!Array.isArray(rows)) return { installed: true, ok: false, agents: [] };
    const agents = rows.map(a => ({
      agent: asString(asRecord(a)?.agent) ?? "",
      cwd: asString(asRecord(a)?.cwd) ?? "",
      pane: asString(asRecord(a)?.pane_id) ?? "",
      status: asString(asRecord(a)?.agent_status) ?? "",
    })).filter(a => a.agent && a.cwd);
    return { installed: true, ok: true, agents };
  } catch { return { installed: true, ok: false, agents: [] }; }
}

// The login job races herdr's restore: panes land over the first seconds after boot, and a seat
// judged missing before its pane returns is launched twice. Bounded: herdr that never answers
// inside the window reads { installed: true, ok: false }, and the caller launches nothing (#8716).
export async function waitForHerdr({ timeoutMs = 120000, everyMs = 5000, probe = herdrAgents } = {}) {
  const deadline = Date.now() + timeoutMs;
  let h = probe();
  while (h.installed && !h.ok && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, everyMs));
    h = probe();
  }
  return h;
}

// Status of every declared seat: live (held by a process or a herdr pane standing in its
// directory), unknown (a blind spot could be hiding the holder — launched over by nothing), or
// missing (with why). `live` and `herdr` are injectable so a drill pins the mapping without
// spawning processes named "claude" or a real herdr.
export function seatStatus(live = liveAgentDirs(), herdr = herdrAgents()) {
  const seats = readSeats();
  return Object.entries(seats).map(([project, { dir, agent }]) => {
    // The seat is held only by the agent it was DECLARED for. A crew seat (opencode, codex) working
    // in the same repo is not the operator's Claude session, and counting it "live" would silently
    // refuse to restore the very window that went missing — a false green in the one place this
    // feature exists to prevent. Report the other occupant, never mistake it for the seat.
    const inDir = live.filter(p => p.cwd === dir);
    const holder = inDir.find(p => p.comm === agent);
    const others = inDir.filter(p => p.comm !== agent);
    const exists = existsSync(dir);
    let pane = null;
    if (herdr.ok) {
      for (const a of herdr.agents) {
        if (a.cwd !== dir) continue;
        if (a.agent === agent) { if (!holder) pane = a.pane || "herdr pane"; }
        else others.push({ pid: null, comm: a.agent, cwd: dir, pane: a.pane });
      }
    }
    // UNKNOWN (#8716): an agent process whose cwd lsof could not read could be standing in this
    // directory, and a herdr that is installed but would not answer could be holding this seat.
    // Either way the holder is unprovable in both directions — the seat is not live, and it is
    // never missing, because launching into an occupied seat is the harm this file prevents.
    const unreadable = live.filter(p => p.cwd === null && p.comm === agent);
    const herdrDark = herdr.installed && !herdr.ok;
    const unknown = exists && !holder && !pane && (unreadable.length > 0 || herdrDark);
    const why = holder || pane ? ""
      : !exists ? "directory does not exist"
      : unknown ? (unreadable.length
        ? `lsof could not read the cwd of ${unreadable.map(p => `${agent} ${p.pid}`).join(", ")} — it could be this seat`
        : "herdr is installed but would not answer — a restored pane could be standing here")
      : others.length ? `no ${agent} here (${others.map(o => o.pane ? `${o.comm} pane ${o.pane}` : `${o.comm} ${o.pid}`).join(", ")} is, but that is not this seat)`
      : `no ${agent} process in this directory`;
    return {
      project, dir, exists, agent,
      live: !!holder || !!pane,
      state: holder || pane ? "live" : unknown ? "unknown" : "missing",
      pid: holder?.pid || null,
      pane,
      others,
      hub: resolveHubInfo(project).url,
      via: resolveHubInfo(project).via,
      why,
    };
  }).sort((a, b) => a.project.localeCompare(b.project));
}

// Seats a recovery may LAUNCH: declared, directory present, and provably held by nothing. An
// unknown seat is never here (#8716) — the one failure this file exists to prevent is opening a
// second window into a seat that is already held.
export function missingSeats(live, herdr) {
  return seatStatus(live, herdr).filter(s => s.state === "missing" && s.exists);
}

// ── recovery ────────────────────────────────────────────────────────────────────
// Restore a missing seat as a herdr pane: `trantor open <project>` run in the seat's own
// directory — never a Terminal.app window, whose twin once ran for hours beside the seat it
// duplicated (#8716). Herdr absent: return the command for the caller to print, spawn nothing.
const SESSION_IDENTITY_ENV = ["TRANTOR_ORCH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDECODE"];
export function launchSeat(seat, { dryRun = false, spawnFn = spawn, env = process.env, which = execFileSync } = {}) {
  let trantor = "trantor";
  try { trantor = which("/usr/bin/which", ["trantor"], { encoding: "utf8", timeout: 4000 }).trim() || "trantor"; } catch {}
  const cmd = `cd ${JSON.stringify(seat.dir)} && ${trantor} open ${seat.project}`;
  let herdr = false;
  try { herdr = !!which("/usr/bin/which", ["herdr"], { encoding: "utf8", timeout: 4000 }).trim(); } catch {}
  if (dryRun || !herdr) return { launched: false, command: cmd };
  // The recovery job may itself run inside a pane or a Claude session; its identity env must not
  // leak into the restored one (#7414), and trantor open's own badge check would refuse it anyway.
  const clean = { ...env };
  for (const k of SESSION_IDENTITY_ENV) delete clean[k];
  try {
    const kid = spawnFn(trantor, ["open", seat.project], { cwd: seat.dir, env: clean, detached: true, stdio: "ignore" });
    kid.unref();
    return { launched: true, command: cmd };
  } catch (e) {
    return { launched: false, command: cmd, error: e?.message || String(e) };
  }
}

// Seed the registry from what is already true: every pinned project whose name matches a directory
// under a workspace root. Suggestion only — the caller confirms before anything is written, because
// a guessed seat is exactly the kind of inference this file exists to replace.
export function suggestSeats(workspace) {
  const cfg = readConfig();
  const pinned = Object.keys(asRecord(cfg?.hubs) ?? {});
  const declared = readSeats();
  const out = [];
  for (const project of pinned) {
    if (declared[project]) continue;
    const dir = resolve(workspace, project);
    if (existsSync(dir)) out.push({ project, dir });
  }
  return out;
}

// The project a directory would register as — so `seats add` can warn when the declared name and
// the directory's own identity disagree (they must match, or the seat comes up under a name the
// operator did not declare and nothing routes to it).
export function projectForDir(dir) { return resolveProject(dir); }
