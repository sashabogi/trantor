// trantor — resource inventory (INTERSESSION-OPS-CONTRACT #4214). PURE DETECTION: what crew
// tracking rows exist, which crew runners are actually alive, which cmux workspaces are open,
// which dev servers run under a directory. Sessions ADOPT live crews; boots clean the provably
// dead. Provably dead = no live process AND no bus heartbeat AND no owning session — one signal
// is never proof, and NOTHING here ever kills a process. The only mutation is cleanDead(), which
// shells `crew.sh prune` (drops dead TRACKING ROWS, never processes).
//
// Hard rules (contract-frozen): every export is fail-silent ([] / "" on any error, never throws)
// and every subprocess has a ≤2s timeout. Hooks run inside the user's tool loop — a throw or a
// hang breaks a session.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { gitRoot } from "../../lib/project.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));            // <pkg>/hooks/lib
const PKGROOT = join(HERE, "..", "..");
const CMUX_APP_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const TIMEOUT = 2000;                                            // contract: every subprocess ≤2s

const busDir = () => process.env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");

// Run a subprocess, return stdout; "" on ANY failure (missing binary, nonzero exit, timeout).
function run(cmd, args, env = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8", timeout: TIMEOUT,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...env },
    });
  } catch { return ""; }
}

// Same, but reports ENOENT separately so callers can fall back to an alternate binary path
// WITHOUT masking a real failure of a binary that exists (a cmux that ran and said "socket off"
// must yield [], not trigger a retry against a second cmux).
function runMaybeMissing(cmd, args, env = {}) {
  try {
    return { out: execFileSync(cmd, args, {
      encoding: "utf8", timeout: TIMEOUT,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...env },
    }), missing: false };
  } catch (e) { return { out: "", missing: e && e.code === "ENOENT" }; }
}

// ~/.agent-bus/crew-windows.txt → [{project,kind,agent,handle}]. Row schema (crew.sh v3):
// PROJECT<TAB>KIND<TAB>AGENT<TAB>HANDLE, KIND ∈ win|attach|tmux|cmux|cmuxws. Legacy v2 rows are
// bare AGENT<TAB>WID (2 fields, no project) → {project:"",kind:"win"}. Anything else is skipped.
export function listCrewRows() {
  try {
    const f = join(busDir(), "crew-windows.txt");
    if (!existsSync(f)) return [];
    const out = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const p = line.split("\t");
      if (p.length >= 4) out.push({ project: p[0], kind: p[1], agent: p[2], handle: p[3] });
      else if (p.length === 2 && p[0]) out.push({ project: "", kind: "win", agent: p[0], handle: p[1] });
    }
    return out;
  } catch { return []; }
}

// Parse `ps -axo pid=,command=` once; shared by liveRunners() and devServers().
function psTable() {
  const out = run("ps", ["-axo", "pid=,command="]);
  const rows = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S.*)$/);
    if (m) rows.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return rows;
}

// Live crew-runner processes → [{pid,agent,dir}]. Runner argv (crew.sh RUN_CMD) is
// `node …/crew-runner.mjs <agent> <dir>` — dir is the LAST argument, so the regex is anchored
// on end-of-string. project=null → all runners; project given → only runners whose dir resolves
// to that project. Resolution is the lib/project.mjs walk (git-root basename, else dir basename)
// compared with EXACT equality — a substring/prefix test would let …/proj match a runner in
// …/proj2 (the sibling-project reap bug).
export function liveRunners(project = null) {
  try {
    const out = [];
    for (const { pid, cmd } of psTable()) {
      const m = cmd.match(/crew-runner\.mjs\s+(\S+)\s+(\S+)\s*$/);
      if (!m) continue;
      const [, agent, dir] = m;
      if (project != null) {
        const name = basename(gitRoot(dir) || dir);
        if (name !== project) continue;
      }
      out.push({ pid, agent, dir });
    }
    return out;
  } catch { return []; }
}

// Open cmux workspaces → [{id,title}] via `cmux workspace list --json` (CMUX_QUIET=1). The socket
// may be off or cmux uninstalled — both are []. The CLI can print notice chatter before the JSON,
// so parse from the first [ or { (same trick as crew.sh).
export function cmuxWorkspaces() {
  try {
    let r = runMaybeMissing("cmux", ["workspace", "list", "--json"], { CMUX_QUIET: "1" });
    if (r.missing) r = runMaybeMissing(CMUX_APP_BIN, ["workspace", "list", "--json"], { CMUX_QUIET: "1" });
    if (!r.out) return [];
    const i = r.out.search(/[\[{]/);
    if (i < 0) return [];
    const o = JSON.parse(r.out.slice(i));
    const a = Array.isArray(o) ? o : (o.workspaces || []);
    if (!Array.isArray(a)) return [];
    return a
      .map(w => ({ id: String(w?.id ?? ""), title: String(w?.custom_title ?? w?.name ?? w?.title ?? "") }))
      .filter(w => w.id);
  } catch { return []; }
}

// Dev-ish processes (next dev | vite | npm run dev | tail -f) whose CWD is under dir →
// [{pid,cmd}]. CWD comes from `lsof -a -p <pid> -d cwd -Fn`. "Under" is anchored: cwd === dir or
// cwd starts with dir + path separator — never a bare prefix (…/proj must not swallow …/proj2).
const DEV_RE = /(?:^|\/)next\s+dev(?:\s|$)|(?:^|\s|\/)vite(?:\s|$)|\bnpm\s+run\s+dev\b|\btail\s+-f\b/;
export function devServers(dir) {
  try {
    if (!dir) return [];
    const root = String(dir).replace(/\/+$/, "");
    if (!root) return [];
    const out = [];
    for (const { pid, cmd } of psTable()) {
      if (!DEV_RE.test(cmd)) continue;
      const lsof = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      const cwd = (lsof.match(/^n(.+)$/m) || [])[1]?.replace(/\/+$/, "") || "";
      if (cwd && (cwd === root || cwd.startsWith(root + "/"))) out.push({ pid, cmd });
    }
    return out;
  } catch { return []; }
}

// Compose the full inventory. project=null → machine-wide; devServers only when a directory for
// the project is actually known (a live runner's dir, or our own cwd when it resolves to the
// project) — else [].
export function inventory(project = null) {
  try {
    const rows = listCrewRows();
    const runners = liveRunners(project);
    const workspaces = cmuxWorkspaces();
    let devs = [];
    if (project != null) {
      let dir = runners[0]?.dir || "";
      if (!dir) {
        const cwd = process.cwd();
        if (basename(gitRoot(cwd) || cwd) === project) dir = cwd;
      }
      if (dir) devs = devServers(dir);
    }
    return { rows, runners, workspaces, devServers: devs };
  } catch { return { rows: [], runners: [], workspaces: [], devServers: [] }; }
}

// The ONLY mutation: `bash <pkgroot>/bin/crew.sh prune` — drops crew-windows.txt rows whose
// handles are provably dead (never touches a process). RELAY_PROJECT is set when a project is
// given. Returns the command's stdout; "" on any failure.
export function cleanDead(project = null) {
  return run("bash", [join(PKGROOT, "bin", "crew.sh"), "prune"],
    project ? { RELAY_PROJECT: String(project) } : {});
}
