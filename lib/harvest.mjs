// Harvest receipts (#7748): a seat commit landed on main under a NEW sha (cherry-pick, squash)
// diverges the seat branch for good. The receipt records seat sha -> main sha -> card so
// `trantor sync` can realign the seat without anyone re-proving patch-equivalence.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { busDir } from "./project.mjs";

const SHA_RE = /^[0-9a-f]{7,40}$/;

export function receiptsPath(project, root = busDir()) {
  return join(root, `harvest-${project}.json`);
}

export function readReceipts(project, root = busDir()) {
  const p = receiptsPath(project, root);
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(j?.receipts) ? j.receipts : [];
  } catch { return []; }
}

// A hand-typed receipt carries a short sha, so either side may be a prefix of the other.
export function shaMatches(a, b) {
  const x = String(a || "").toLowerCase(), y = String(b || "").toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

export function recordHarvest(project, { seat, main, card = 0, branch = "", by = "" }, root = busDir()) {
  const seatSha = String(seat || "").trim().toLowerCase();
  const mainSha = String(main || "").trim().toLowerCase();
  if (!SHA_RE.test(seatSha) || !SHA_RE.test(mainSha)) throw new Error("harvest: a sha is 7 to 40 hex characters");
  const list = readReceipts(project, root).filter(r => !shaMatches(r.seat, seatSha));
  const receipt = { seat: seatSha, main: mainSha, card: Number(card) || 0, branch: String(branch || ""), by: String(by || ""), ts: Date.now() };
  list.push(receipt);
  const p = receiptsPath(project, root);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ project, receipts: list }, null, 2) + "\n");
  renameSync(tmp, p);
  return receipt;
}

export function run(cwd, args, { timeout = 15000 } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout });
  return { ok: r.status === 0, out: String(r.stdout || "").trim(), err: String(r.stderr || "").trim() };
}
const out = (cwd, args) => { const r = run(cwd, args); return r.ok ? r.out : ""; };

// The runner persists branch.<seat>.base at worktree creation; a worktree made by hand means main.
export function seatBase(dir, branch) {
  return out(dir, ["config", "--get", `branch.${branch}.base`]) || "main";
}

// Realignment target: the remote base when origin carries it, else the local base branch.
export function syncTarget(dir, base) {
  const remote = out(dir, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`]);
  if (remote) return { ref: `origin/${base}`, sha: remote };
  const local = out(dir, ["rev-parse", "--verify", "-q", `refs/heads/${base}`]);
  return { ref: base, sha: local };
}

// Every commit the seat branch carries that the target does not, split by whether a receipt covers it.
export function auditSeat(dir, { branch, targetRef, receipts }) {
  const log = out(dir, ["log", "--reverse", "--format=%H%x09%s", `${targetRef}..${branch}`]);
  const harvested = [], unharvested = [];
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, ...rest] = line.split("\t");
    const subject = rest.join("\t");
    const receipt = receipts.find(r => shaMatches(r.seat, sha));
    (receipt ? harvested : unharvested).push({ sha, subject, receipt });
  }
  return { harvested, unharvested };
}

// Refuses rather than loses: an unharvested commit stops the sync and is named. `reset --keep`
// carries uncommitted edits across and refuses on its own when one touches a file main changed.
export function syncSeat(dir, { branch = "", dryRun = false, fetch = true, receipts, root = busDir(), project = "" } = {}) {
  const current = out(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!current || current === "HEAD") return { ok: false, reason: `${dir} has no branch checked out (detached HEAD)` };
  if (branch && branch !== current) return { ok: false, reason: `${dir} is on ${current}, not ${branch}` };
  branch = current;
  const base = seatBase(dir, branch);
  if (fetch) run(dir, ["fetch", "-q", "origin", base], { timeout: 20000 });
  const target = syncTarget(dir, base);
  if (!target.sha) return { ok: false, reason: `no ${base} to sync to: neither origin/${base} nor a local ${base} exists` };
  const audit = auditSeat(dir, { branch, targetRef: target.sha, receipts: receipts || readReceipts(project, root) });
  const head = out(dir, ["rev-parse", "HEAD"]);
  const result = { ok: true, branch, base, target, head, ...audit };
  if (audit.unharvested.length) return { ...result, ok: false, refused: true, reason: `${audit.unharvested.length} unharvested commit(s) on ${branch} would be lost` };
  if (head === target.sha) return { ...result, noop: true };
  if (dryRun) return { ...result, dry: true };
  const r = run(dir, ["reset", "--keep", target.sha]);
  if (!r.ok) return { ...result, ok: false, reason: `git reset --keep refused: ${r.err || r.out}`.trim() };
  return { ...result, from: head, to: target.sha };
}
