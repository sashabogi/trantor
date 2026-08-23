// trantor — DECLARED SEATS: which project belongs in which directory, and whether it is running.
//
// A session's identity is positional (lib/project.mjs): a window IS whatever folder it stands in.
// That is fine while nothing moves it. A macOS reboot moves all of them: reopened Terminal windows
// come back in $HOME, `claude --resume` restores the conversation but not the directory, and every
// seat quietly becomes a non-seat (2026-08-23 — two crebral windows spent an hour believing they
// were still seats and finally reported the bus as down).
//
// 0.17.81 made that state LOUD. This makes it RECOVERABLE: the operator declares, once, that
// "crebral-health" lives in ~/development/crebral-health, and afterwards a single command — or a
// login agent — puts every missing seat back in its own directory. Nothing here guesses: a seat
// exists because it was declared, and it is live because a real process is standing in its dir.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, writeConfigPublic, resolveProject, resolveHubInfo } from "./project.mjs";

// ── the registry ────────────────────────────────────────────────────────────────
// config.json gains `seats: { <project>: { dir } }`. Same file as `hubs`, same shape of decision:
// a deliberate operator statement, not an inference.
export function readSeats() {
  try {
    const s = readConfig()?.seats;
    if (!s || typeof s !== "object") return {};
    const out = {};
    for (const [p, v] of Object.entries(s)) {
      const dir = typeof v === "string" ? v : v?.dir;
      if (typeof dir === "string" && dir) out[p] = { dir };
    }
    return out;
  } catch { return {}; }
}

export function declareSeat(project, dir) {
  if (!project || typeof project !== "string") throw new Error("project required");
  const abs = resolve(dir || process.cwd());
  if (!existsSync(abs)) throw new Error(`directory does not exist: ${abs}`);
  const cfg = readConfig();
  cfg.seats = { ...(cfg.seats && typeof cfg.seats === "object" ? cfg.seats : {}), [project]: { dir: abs } };
  writeConfigPublic(cfg);
  return { project, dir: abs };
}

export function undeclareSeat(project) {
  const cfg = readConfig();
  if (!cfg.seats || typeof cfg.seats !== "object" || !(project in cfg.seats)) return false;
  delete cfg.seats[project];
  if (!Object.keys(cfg.seats).length) delete cfg.seats;
  writeConfigPublic(cfg);
  return true;
}

// ── liveness ────────────────────────────────────────────────────────────────────
// A seat is live when a real agent process is STANDING IN ITS DIRECTORY. Deliberately local and
// deliberately not the hub's presence list: the hub says a peer named "crebral-health" checked in,
// which is exactly the claim that was false all along (a home-dir session can assert any name, and
// a stale registration outlives the process). A cwd is not assertable.
//
// `ps` gives the candidate pids; lsof resolves each one's cwd. Both are bounded and fail-soft —
// this runs in a CLI and, via `seats status`, in a login agent.
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
    let cwd = "";
    try {
      const fn = execFileSync("/usr/sbin/lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"],
        { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
      const hit = fn.split("\n").find(l => l.startsWith("n"));
      if (hit) cwd = hit.slice(1);
    } catch { /* process died, or lsof is unavailable — treat as unknown, never as live */ }
    if (cwd) out.push({ pid: Number(pid), comm: base, cwd });
  }
  return out;
}

// Status of every declared seat: live (with the pid holding it) or missing (with why).
// `live` is injectable so a drill can pin the mapping without spawning processes named "claude".
export function seatStatus(live = liveAgentDirs()) {
  const seats = readSeats();
  return Object.entries(seats).map(([project, { dir }]) => {
    const holder = live.find(p => p.cwd === dir);
    const exists = existsSync(dir);
    return {
      project, dir, exists,
      live: !!holder,
      pid: holder?.pid || null,
      agent: holder?.comm || null,
      hub: resolveHubInfo(project).url,
      via: resolveHubInfo(project).via,
      why: holder ? "" : (exists ? "no agent process in this directory" : "directory does not exist"),
    };
  }).sort((a, b) => a.project.localeCompare(b.project));
}

// Seats that are declared, whose directory exists, and that nothing is standing in.
export function missingSeats(live) { return seatStatus(live).filter(s => !s.live && s.exists); }

// ── recovery ────────────────────────────────────────────────────────────────────
// Open a NEW terminal window in the seat's directory running the agent. macOS-only by design (the
// same osascript bin/open-session.sh has always used); elsewhere we print the command instead of
// pretending. Returns { launched, command }.
export function launchSeat(seat, { command = "claude", dryRun = false } = {}) {
  const cmd = `cd ${JSON.stringify(seat.dir)} && ${command}`;
  if (dryRun || process.platform !== "darwin") return { launched: false, command: cmd };
  const osa = `tell application "Terminal"\n  do script ${JSON.stringify(cmd)}\nend tell\n`;
  try {
    const kid = spawn("/usr/bin/osascript", ["-e", osa], { detached: true, stdio: "ignore" });
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
  const pinned = cfg?.hubs && typeof cfg.hubs === "object" ? Object.keys(cfg.hubs) : [];
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
