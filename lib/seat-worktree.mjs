// Seat worktrees (#5403, #7760): one linked git worktree per seat under ~/.agent-bus/worktrees, and
// the project's own declaration of what such a worktree needs before it can build.
import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const DECLARATION_PATH = join(".trantor", "worktree.json");
export const PREFLIGHT_CAP_MS = 5 * 60 * 1000;
const PROVISION_MODES = new Set(["link", "stub", "operator"]);

export function safePathSegment(s) {
  return String(s).replace(/\.{2,}/g, "_").replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function seatWorktreeDir(project, agent, home = homedir()) {
  return join(home, ".agent-bus", "worktrees", safePathSegment(project), safePathSegment(agent));
}

function gitOut(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000 });
  return r.status === 0 ? String(r.stdout || "").trim() : "";
}

// Returns { dir, created }: dir is the seat worktree, or sourceDir when no worktree applies
// (non-git source, opt-out, or a creation failure — loud, never fatal: stale beats broken).
export function ensureSeatWorktree({ sourceDir, project, agent, home = homedir(), env = process.env, log = console.log }) {
  if (env.TRANTOR_NO_WORKTREE === "1") return { dir: sourceDir, created: false };
  const root = gitOut(["-C", sourceDir, "rev-parse", "--show-toplevel"], sourceDir);
  if (!root) return { dir: sourceDir, created: false };

  spawnSync("git", ["-C", root, "worktree", "prune"], { stdio: "ignore", timeout: 8000 });
  const seatDir = seatWorktreeDir(project, agent, home);
  const branch = `seat/${agent}`;
  if (existsSync(seatDir)) {
    const ok = gitOut(["-C", seatDir, "rev-parse", "--is-inside-work-tree"], seatDir) === "true";
    if (ok) {
      // #5403: refresh only a CLEAN tree — a dirty tree is a seat's unintegrated work and a
      // diverged branch is a decision; refreshing must eat neither.
      const dirty = gitOut(["-C", seatDir, "status", "--porcelain"], seatDir);
      if (dirty === "") {
        const head = gitOut(["-C", root, "rev-parse", "HEAD"], root);
        const ff = head && spawnSync("git", ["-C", seatDir, "merge", "--ff-only", head], { stdio: "ignore", timeout: 15000 });
        if (ff && ff.status === 0) log(`\x1b[2m[runner]\x1b[0m ${branch} worktree refreshed to ${head.slice(0, 7)}`);
        else log(`\x1b[33m[runner]\x1b[0m ${branch} worktree diverged from main HEAD — left as-is (integrate or reset it)`);
      } else {
        log(`\x1b[33m[runner]\x1b[0m ${branch} worktree has uncommitted work — not refreshed`);
      }
      return { dir: seatDir, created: false, root, dirty: dirty !== "" };
    }
    log(`\x1b[33m[runner]\x1b[0m worktree path exists but is not a git worktree: ${seatDir} — using ${sourceDir}`);
    return { dir: sourceDir, created: false };
  }

  try { mkdirSync(dirname(seatDir), { recursive: true }); } catch {}

  // Fast-forward the base branch before branching, so the worktree builds against latest main (#5403).
  const base = gitOut(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], root);
  if (base) {
    const remote = gitOut(["-C", root, "rev-parse", "--abbrev-ref", `${base}@{upstream}`], root);
    if (remote) {
      const ff = spawnSync("git", ["-C", root, "merge", "--ff-only", remote], { stdio: "ignore", timeout: 15000 });
      if (ff && ff.status === 0) log(`\x1b[2m[runner]\x1b[0m ${base} fast-forwarded to ${remote}`);
    }
  }

  const r = spawnSync("git", ["-C", root, "worktree", "add", "--no-track", "-B", branch, seatDir, "HEAD"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
  });
  if (r.status === 0) {
    // branch.<b>.base names the real base for the Review lens; push.autoSetupRemote makes the
    // first plain push set its upstream (#5403).
    if (base) spawnSync("git", ["-C", seatDir, "config", `branch.${branch}.base`, base], { stdio: "ignore", timeout: 5000 });
    const pushAuto = gitOut(["-C", seatDir, "config", "--get", "push.autoSetupRemote"], seatDir);
    if (!pushAuto) spawnSync("git", ["-C", seatDir, "config", "push.autoSetupRemote", "true"], { stdio: "ignore", timeout: 5000 });
    return { dir: seatDir, created: true, root, dirty: false };
  }
  log(`\x1b[33m[runner]\x1b[0m could not create ${branch} worktree — using ${sourceDir}`);
  return { dir: sourceDir, created: false };
}

// The declaration: { link: [<relative sibling path>], provision: [{ path, mode, template? }],
// preflight: "<shell command>" }. null when the project declares nothing (unchanged behaviour).
export function readWorktreeDeclaration(root) {
  const file = join(root, DECLARATION_PATH);
  if (!existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { return { link: [], provision: [], preflight: "", problems: [`${DECLARATION_PATH}: not valid JSON (${e.message})`] }; }
  const problems = [];
  const linkRaw = raw.link ?? [];
  if (!Array.isArray(linkRaw)) problems.push(`${DECLARATION_PATH}: "link" must be an array of relative paths`);
  const link = (Array.isArray(linkRaw) ? linkRaw : []).map((v) => String(v ?? "")).filter(Boolean);
  const provision = [];
  for (const p of Array.isArray(raw.provision) ? raw.provision : []) {
    const path = String(p?.path ?? "");
    const mode = String(p?.mode ?? "");
    if (!path) { problems.push(`${DECLARATION_PATH}: a provision entry has no "path"`); continue; }
    if (!PROVISION_MODES.has(mode)) { problems.push(`${DECLARATION_PATH}: ${path}: mode must be link|stub|operator`); continue; }
    provision.push({ path, mode, template: String(p.template ?? "") });
  }
  const preflight = String(raw.preflight ?? "").trim();
  return { link, provision, preflight, problems };
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function linkOne(target, at) {
  if (existsSync(at) || isSymlink(at)) {
    const current = isSymlink(at) ? resolve(dirname(at), readlinkSync(at)) : "";
    return current === resolve(target) ? "kept" : "occupied";
  }
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at);
  return "linked";
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Applies a declaration to one seat worktree. Sibling links land where the SAME relative path
// resolves from the worktree; a declared file is linked or stubbed, never copied; "operator"
// entries are only named. Returns what happened, per entry, so up and the runner can print it.
export function applyWorktreeDeclaration(decl, { root, seatDir }) {
  const out = { linked: [], provisioned: [], operator: [], problems: [...(decl.problems || [])] };
  for (const entry of decl.link) {
    const target = resolve(root, entry);
    if (isAbsolute(entry) || inside(root, target)) { out.problems.push(`link ${entry}: must be a relative path outside the repo (a sibling checkout)`); continue; }
    if (!existsSync(target)) { out.problems.push(`link ${entry}: sibling checkout missing at ${target}`); continue; }
    const at = resolve(seatDir, entry);
    if (inside(seatDir, at)) { out.problems.push(`link ${entry}: resolves inside the worktree`); continue; }
    const how = linkOne(target, at);
    if (how === "occupied") out.problems.push(`link ${entry}: ${at} exists and is not a link to ${target}`);
    else out.linked.push(`${entry} -> ${target}${how === "kept" ? " (already linked)" : ""}`);
  }
  for (const p of decl.provision) {
    const at = resolve(seatDir, p.path);
    if (isAbsolute(p.path) || !inside(seatDir, at) || at === seatDir) { out.problems.push(`provision ${p.path}: must be a relative path inside the repo`); continue; }
    if (p.mode === "operator") { out.operator.push(`${p.path}: operator step — put the real file at ${at}`); continue; }
    const tracked = spawnSync("git", ["-C", seatDir, "ls-files", "--error-unmatch", "--", p.path], { stdio: "ignore", timeout: 8000 }).status === 0;
    if (tracked) { out.problems.push(`provision ${p.path}: tracked in git, nothing to provision`); continue; }
    const ignored = spawnSync("git", ["-C", seatDir, "check-ignore", "-q", "--", p.path], { stdio: "ignore", timeout: 8000 }).status === 0;
    const note = ignored ? "" : " (not gitignored — the seat will see it as an untracked change)";
    if (p.mode === "link") {
      const source = resolve(root, p.path);
      if (!existsSync(source)) { out.problems.push(`provision ${p.path}: mode link but ${source} is missing in the main checkout`); continue; }
      const how = linkOne(source, at);
      if (how === "occupied") out.problems.push(`provision ${p.path}: ${at} exists and is not a link to ${source}`);
      else out.provisioned.push(`${p.path}: linked to ${source}${how === "kept" ? " (already)" : ""}${note}`);
      continue;
    }
    if (existsSync(at) || isSymlink(at)) { out.provisioned.push(`${p.path}: already present (kept)`); continue; }
    let body = "";
    if (p.template) {
      const tpl = resolve(root, p.template);
      if (!existsSync(tpl)) { out.problems.push(`provision ${p.path}: template ${p.template} missing in the repo`); continue; }
      body = readFileSync(tpl, "utf8");
    }
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, body);
    out.provisioned.push(`${p.path}: stubbed${p.template ? ` from ${p.template}` : " (empty)"}${note}`);
  }
  return out;
}

export function provisioningLines(applied, { prefix = "" } = {}) {
  const lines = [];
  for (const l of applied.linked) lines.push(`${prefix}linked ${l}`);
  for (const l of applied.provisioned) lines.push(`${prefix}provisioned ${l}`);
  for (const l of applied.operator) lines.push(`${prefix}OPERATOR ${l}`);
  for (const l of applied.problems) lines.push(`${prefix}✗ ${l}`);
  return lines;
}

const TAIL_LINES = 20;

// Runs the declared preflight once, in the given worktree, under a hard cap. The last lines of
// output are the whole report: the orchestrator needs what failed, not a transcript.
export function runPreflight(command, { seatDir, capMs = PREFLIGHT_CAP_MS, env = process.env }) {
  const started = Date.now();
  const r = spawnSync("/bin/sh", ["-c", command], {
    cwd: seatDir, encoding: "utf8", env, timeout: capMs, killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = r.error?.code === "ETIMEDOUT" || (r.signal === "SIGKILL" && Date.now() - started >= capMs);
  const output = `${r.stdout || ""}${r.stderr || ""}`.split("\n").filter((l) => l.trim());
  const tail = output.slice(-TAIL_LINES);
  if (timedOut) tail.push(`preflight killed after ${Math.round(capMs / 1000)}s cap`);
  else if (r.error) tail.push(`could not run preflight: ${r.error.message}`);
  const ok = !r.error && r.status === 0;
  return { ok, timedOut, status: r.status, tail, durationMs: Date.now() - started, command };
}

export function preflightLine(result) {
  if (result.ok) return `preflight ok (${result.command}, ${Math.round(result.durationMs / 1000)}s)`;
  return `preflight failed: ${result.tail.join("\n")}`;
}
