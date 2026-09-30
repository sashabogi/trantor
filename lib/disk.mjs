// trantor disk — measure first, print the list, delete ONLY the provably safe tier
// (unavailable simulators via simctl, build output in seat worktrees whose runner is
// dead, opencode sessions idle >14d via the official CLI). Everything else is
// REPORT-only; our own deletions are fs.rm on paths asserted under $HOME, never rm -rf.
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { join, resolve, sep, basename, dirname } from "node:path";
import { homedir } from "node:os";

export const DAY = 24 * 60 * 60 * 1000;
export const BUILD_DIRS = [".next", "target", "desktop/src-tauri/target"];
export const SESSION_IDLE_MAX = 14 * DAY;

const GB = 1024 ** 3;
const KB = 1024;

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= KB) return `${Math.round(n / KB)} KB`;
  return `${n} B`;
}

// The one gate every delete-on-disk must pass. resolve() first: a `..` or a symlink
// spell in the path must not smuggle it outside $HOME past a string prefix check.
export function assertUnderHome(path, home) {
  const child = resolve(String(path));
  const root = resolve(String(home));
  if (child === root || child.startsWith(root.endsWith(sep) ? root : root + sep)) return child;
  throw new Error(`refused: ${child} is not under ${root}`);
}

function isUnder(path, parent) {
  const child = resolve(String(path));
  const root = resolve(String(parent));
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

// Default dependency kit — every call site takes `d` so tests inject a temp HOME,
// a canned exec and a recording remove, and no real simctl/opencode/docker ever runs.
function defaults(d = {}) {
  return {
    fs: d.fs || nodeFs,
    exec: d.exec || ((file, args) => {
      const r = spawnSync(file, args, { encoding: "utf8" });
      return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status ?? 1 };
    }),
    remove: d.remove || null,
    home: d.home || homedir(),
    now: d.now || Date.now(),
    worktreesRoot: d.worktreesRoot || null,
    entryBudget: d.entryBudget || 400_000,
  };
}

// Recursive size walk. Skips symlinks entirely — a worktree symlink must not make
// us measure (or later rm) outside its root. Budget caps pathological trees.
export function dirSize(fs, path, { entryBudget = 400_000 } = {}) {
  let bytes = 0, files = 0, partial = false, seen = 0;
  const stack = [String(path)];
  while (stack.length) {
    if (seen++ > entryBudget) { partial = true; break; }
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      try { bytes += fs.statSync(p).size; files++; } catch {}
    }
  }
  return { bytes, files, partial };
}

export function freeSpace(fs, path = "/") {
  try {
    const s = fs.statfsSync(path);
    return { free: Number(s.bfree) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
  } catch { return { free: 0, total: 0 }; }
}

// One `ps` snapshot answers "is anything alive that uses this path" for every check
// below: crew-runner workdirs, opencode run -c, portless/next dev servers all carry
// the worktree path on their command line. Fails open as [] only when ps is unusable.
export function liveCommandLines(exec) {
  const r = exec("ps", ["-axo", "command="]);
  if (r.status !== 0 && !r.stdout) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

function gitOut(exec, args) {
  const r = exec("git", args);
  return r.status === 0 ? String(r.stdout || "") : "";
}

// A build dir that git tracks is source-adjacent state, not disposable output —
// deleting it would fight the checkout. Checked per candidate, never assumed.
export function gitTracked(exec, worktree, rel) {
  return gitOut(exec, ["-C", worktree, "ls-files", "--", rel]).trim().length > 0;
}

export function scanSeatWorktrees(d) {
  const { fs, exec, home, now } = d;
  const root = d.worktreesRoot || join(home, ".agent-bus", "worktrees");
  const live = liveCommandLines(exec);
  const seats = [], plan = [], kept = [];
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch { return { root, seats, plan, kept }; }
  for (const proj of projects) {
    let seatDirs;
    try { seatDirs = fs.readdirSync(join(root, proj.name), { withFileTypes: true }).filter((e) => e.isDirectory()); }
    catch { continue; }
    for (const seat of seatDirs) {
      const wt = join(root, proj.name, seat.name);
      const isLive = live.some((l) => l.includes(wt));
      const size = dirSize(fs, wt, d);
      seats.push({ project: proj.name, seat: seat.name, path: wt, bytes: size.bytes, live: isLive });
      for (const rel of BUILD_DIRS) {
        const p = join(wt, ...rel.split("/"));
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (!st.isDirectory()) continue;
        if (isLive) { kept.push({ path: p, reason: "KEPT: a live seat process uses this worktree" }); continue; }
        if (gitTracked(exec, wt, rel)) { kept.push({ path: p, reason: `KEPT: ${rel} is git-tracked in ${proj.name}/${seat.name}` }); continue; }
        plan.push({ type: "build-dir", path: p, worktree: wt, project: proj.name, seat: seat.name, bytes: dirSize(fs, p, d).bytes });
      }
    }
  }
  seats.sort((a, b) => b.bytes - a.bytes);
  plan.sort((a, b) => b.bytes - a.bytes);
  return { root, seats, plan, kept };
}

export function scanOpencodeSessions(d) {
  const { exec, now } = d;
  const live = liveCommandLines(exec);
  const rows = [], plan = [], kept = [];
  const r = exec("opencode", ["session", "list", "--format", "json"]);
  let list = [];
  if (r.status === 0 && String(r.stdout).includes("[")) {
    try { list = JSON.parse(String(r.stdout).slice(String(r.stdout).indexOf("["))); } catch { list = []; }
  }
  if (!Array.isArray(list)) list = [];
  for (const s of list) {
    const idleMs = now - Number(s.updated || 0);
    const row = { id: s.id, title: s.title, directory: s.directory, idleDays: Math.max(0, Math.round(idleMs / DAY)) };
    rows.push(row);
    if (idleMs <= SESSION_IDLE_MAX) continue;
    if (s.directory && live.some((l) => l.includes(String(s.directory)))) {
      kept.push({ path: s.directory, reason: `KEPT: session ${s.id} sits in a live process directory` });
      continue;
    }
    plan.push({ type: "opencode-session", id: String(s.id), directory: s.directory || "", cmd: ["opencode", "session", "delete", String(s.id)] });
  }
  return { rows, plan, kept, listed: r.status === 0 };
}

export function scanSimulators(d) {
  const { fs, exec, home } = d;
  const r = exec("xcrun", ["simctl", "list", "devices"]);
  let unavailable = 0, available = false;
  if (r.status === 0) {
    available = true;
    let inUnavail = false;
    for (const line of String(r.stdout).split("\n")) {
      if (line.startsWith("--")) { inUnavail = /Unavailable/i.test(line); continue; }
      if (inUnavail && /\(/.test(line)) unavailable++;
    }
  }
  const devicesDir = join(home, "Library", "Developer", "CoreSimulator", "Devices");
  let bytes = 0;
  try { bytes = dirSize(fs, devicesDir, d).bytes; } catch {}
  const plan = available ? [{ type: "simulators", cmd: ["xcrun", "simctl", "delete", "unavailable"] }] : [];
  return { available, unavailable, bytes, plan };
}

export function reportDocker(exec) {
  const df = exec("docker", ["system", "df", "--format", "{{json .}}"]);
  if (df.status !== 0) return { running: false, note: "docker not running — colima stacks unmeasured" };
  const out = {};
  for (const line of String(df.stdout).split("\n").filter(Boolean)) {
    try { const j = JSON.parse(line); if (j.Type) out[j.Type] = { size: j.Size, reusable: j.Reclaimable }; } catch {}
  }
  const names = exec("docker", ["ps", "-a", "--format", "{{.Names}}"]);
  const byProject = {};
  for (const n of String(names.stdout || "").split("\n").filter(Boolean)) {
    // supabase_db_lindadrive → lindadrive; glm8977 → glm8977. Supabase names one
    // container per service, so per-container rows would flood the report.
    const proj = n.startsWith("supabase_") ? (n.split("_").pop() || n) : n.split("-")[0];
    (byProject[proj] ||= []).push(n);
  }
  return { running: true, df: out, byProject };
}

// Size an HF model by its BLOBS, not its symlinks: snapshot files are symlinks to the
// real weights (per-model blobs/ or the shared hub/blobs store), so realpath each link
// and count every distinct blob once — by dev:ino, which also dedupes hardlinks and
// repeated revs. globalSeen keeps a cross-model shared blob out of totalBytes twice.
export function sizeHfModel(fs, modelDir, { entryBudget = 400_000, globalSeen = null } = {}) {
  let bytes = 0, globalNew = 0, seen = 0, partial = false;
  const counted = new Set();
  const stack = [String(modelDir)];
  while (stack.length) {
    if (seen++ > entryBudget) { partial = true; break; }
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      let st;
      try { st = fs.statSync(e.isSymbolicLink() ? fs.realpathSync(p) : p); }
      catch { continue; }
      if (!st.isFile()) continue;
      const key = `${st.dev}:${st.ino}`;
      if (!counted.has(key)) { counted.add(key); bytes += st.size; }
      if (globalSeen && !globalSeen.has(key)) { globalSeen.add(key); globalNew += st.size; }
    }
  }
  return { bytes, globalNew, partial };
}

export function reportHfCache(d) {
  const { fs, home } = d;
  const hub = join(home, ".cache", "huggingface", "hub");
  let entries;
  try { entries = fs.readdirSync(hub, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("models--")); }
  catch { return { root: hub, models: [], totalBytes: 0 }; }
  const seen = new Set();
  let totalBytes = 0;
  const models = entries.map((e) => {
    const r = sizeHfModel(fs, join(hub, e.name), { entryBudget: d.entryBudget, globalSeen: seen });
    totalBytes += r.globalNew;
    return { model: e.name, bytes: r.bytes };
  }).sort((a, b) => b.bytes - a.bytes).slice(0, 20);
  return { root: hub, models, totalBytes };
}

// Claude agent worktrees are never cleaned here — each row carries dirty and
// unmerged counts, which is exactly the work a reaper would destroy.
export function reportClaudeWorktrees(d) {
  const { fs, exec, home } = d;
  const roots = [join(home, ".claude", "worktrees"), join(home, ".claude", "projects")];
  const rows = [];
  for (const root of roots) {
    let tops;
    try { tops = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
    for (const top of tops) {
      const candidates = root.endsWith("projects") ? listNested(fs, join(root, top.name), "worktrees") : [join(root, top.name)];
      for (const wt of candidates) {
        const dirty = gitOut(exec, ["-C", wt, "status", "--porcelain"]).split("\n").filter(Boolean).length;
        const unmerged = Number(gitOut(exec, ["-C", wt, "rev-list", "--count", "main..HEAD"]).trim()) || 0;
        rows.push({ path: wt, bytes: dirSize(fs, wt, d).bytes, dirty, unmerged });
      }
    }
  }
  return { rows: rows.sort((a, b) => b.bytes - a.bytes) };
}

function listNested(fs, dir, name) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name === name).map((e) => join(dir, e.name));
  } catch { return []; }
}

// Big-file sweep over the known sink roots — deliberately NOT a whole-$HOME walk.
export function collectBigFiles(d, minBytes = GB) {
  const { fs, home } = d;
  const roots = [
    join(home, ".agent-bus"), join(home, ".claude"), join(home, ".cache"),
    join(home, ".colima"), join(home, "Library", "Developer"), join(home, ".local", "share"),
  ];
  const found = [];
  let seen = 0;
  const stack = [...roots];
  while (stack.length) {
    if (seen++ > d.entryBudget) break;
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      try {
        const size = fs.statSync(p).size;
        if (size >= minBytes) found.push({ path: p, bytes: size });
      } catch {}
    }
  }
  return found.sort((a, b) => b.bytes - a.bytes).slice(0, 50);
}

export function buildDiskReport(d) {
  const dep = defaults(d);
  const { fs, home, now } = dep;
  const space = freeSpace(fs, "/");
  const seats = scanSeatWorktrees({ ...dep, entryBudget: dep.entryBudget });
  const sessions = scanOpencodeSessions(dep);
  const sims = scanSimulators(dep);
  const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
  const report = {
    generated: new Date(now).toISOString(),
    home,
    freeBytes: space.free,
    totalBytes: space.total,
    seats: { root: seats.root, rows: seats.seats, totalBytes: seats.seats.reduce((n, s) => n + s.bytes, 0) },
    simulators: { available: sims.available, unavailable: sims.unavailable, bytes: sims.bytes },
    opencode: { listed: sessions.listed, rows: sessions.rows, dbPath, dbBytes: fileSize(fs, dbPath) },
    docker: reportDocker(dep.exec),
    hf: reportHfCache(dep),
    claudeWorktrees: reportClaudeWorktrees(dep),
    bigFiles: collectBigFiles(dep),
    plan: [...sims.plan, ...seats.plan, ...sessions.plan],
    kept: [...seats.kept, ...sessions.kept],
  };
  return report;
}

function fileSize(fs, p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

export function formatHuman(r) {
  const L = [];
  L.push(`trantor disk — ${fmtBytes(r.freeBytes)} free of ${fmtBytes(r.totalBytes)} (${new Date(r.generated).toLocaleString()})`);
  L.push(`seat worktrees: ${fmtBytes(r.seats.totalBytes)} total`);
  for (const s of r.seats.rows.slice(0, 12)) L.push(`  ${s.live ? "LIVE" : "dead"}  ${s.project}/${s.seat}  ${fmtBytes(s.bytes)}`);
  L.push(`simulators: ${fmtBytes(r.simulators.bytes)}${r.simulators.available ? `, ${r.simulators.unavailable} unavailable device(s)` : " (xcrun unavailable)"}`);
  L.push(`opencode sessions: ${r.opencode.rows.length} listed, db ${fmtBytes(r.opencode.dbBytes)} (shrinks only after a VACUUM when no opencode process holds it)`);
  if (r.docker.running) {
    const parts = Object.entries(r.docker.df).map(([k, v]) => `${k} ${v.size}`).join(", ");
    L.push(`docker: ${parts || "no layers"}`);
    for (const [proj, names] of Object.entries(r.docker.byProject)) L.push(`  stack ${proj}: ${names.length} container(s)`);
  } else L.push(`docker: ${r.docker.note}`);
  if (r.hf.models.length) {
    L.push(`huggingface cache: ${fmtBytes(r.hf.totalBytes ?? r.hf.models.reduce((n, m) => n + m.bytes, 0))}`);
    for (const m of r.hf.models.slice(0, 8)) L.push(`  ${m.model}  ${fmtBytes(m.bytes)}`);
  }
  if (r.claudeWorktrees.rows.length) {
    L.push(`claude agent worktrees: ${r.claudeWorktrees.rows.length} (never auto-cleaned)`);
    for (const w of r.claudeWorktrees.rows.slice(0, 8)) L.push(`  ${w.dirty} dirty, ${w.unmerged} unmerged  ${fmtBytes(w.bytes)}  ${basename(dirname(w.path))}/${basename(w.path)}`);
  }
  if (r.bigFiles.length) {
    L.push(`files >1 GB: ${r.bigFiles.length}`);
    for (const f of r.bigFiles.slice(0, 10)) L.push(`  ${fmtBytes(f.bytes)}  ${f.path}`);
  }
  L.push("");
  L.push(`safe tier would delete ${r.plan.length} item(s):`);
  for (const p of r.plan) L.push(`  DELETE ${p.type === "build-dir" ? `${fmtBytes(p.bytes)} ${p.path}` : p.type === "opencode-session" ? `session ${p.id} (idle)` : "unavailable simulators"}`);
  for (const k of r.kept) L.push(`  ${k.reason}${k.path ? `  ${k.path}` : ""}`);
  if (!r.kept.length) L.push("  (nothing held back)");
  return `${L.join("\n")}\n`;
}

// Execute the safe tier. simctl/opencode run as their own CLIs (injected in tests);
// build dirs are removed by the injected `remove` (default fs.rmSync) only after
// assertUnderHome AND an is-under-worktrees-root re-check on the exact path.
export async function runClean(r, d) {
  const dep = defaults(d);
  const { exec, home } = dep;
  const remove = dep.remove || ((p, opts) => dep.fs.rmSync(p, opts));
  const results = [];
  for (const item of r.plan) {
    try {
      if (item.type === "simulators") {
        exec("xcrun", ["simctl", "delete", "unavailable"]);
        results.push({ type: item.type, ok: true });
      } else if (item.type === "opencode-session") {
        exec("opencode", ["session", "delete", item.id]);
        results.push({ type: item.type, id: item.id, ok: true });
      } else if (item.type === "build-dir") {
        const p = assertUnderHome(item.path, home);
        if (!isUnder(p, join(home, ".agent-bus", "worktrees"))) throw new Error(`refused: ${p} is not a seat-worktree build dir`);
        remove(p, { recursive: true, force: true });
        results.push({ type: item.type, path: p, ok: true });
      }
    } catch (e) {
      results.push({ type: item.type, path: item.path || item.id, ok: false, error: String(e.message || e) });
    }
  }
  return results;
}

export function launchdPlist({ nodePath, scriptPath, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.trantor.disk</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>--weekly</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
}

export async function runDisk(d = {}) {
  const dep = defaults(d);
  const clean = d.args?.includes("--clean");
  const json = d.args?.includes("--json");
  const report = buildDiskReport(dep);
  const results = clean ? await runClean(report, dep) : [];
  return { report, results, json, clean };
}
