// Handoff facts computed from git and the board, never from the model (#13871): the model-written
// summary said 9 unpushed commits when git said 17, because nothing cross-checked it.
import { execFileSync } from "node:child_process";
import { DERIVED_NOTE } from "../../lib/state/derive.mjs";

const git = (dir, args) => execFileSync("git", ["-C", dir, ...args],
  { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();

/** Branch, upstream and unpushed count. `ahead` is null (not 0) when it cannot be known. */
export function gitFacts(projectDir) {
  const out = { branch: "", upstream: "", ahead: null };
  try { out.branch = git(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"]); } catch { return out; }
  try {
    out.upstream = git(projectDir, ["rev-parse", "--abbrev-ref", "@{u}"]);
    out.ahead = Number(git(projectDir, ["rev-list", "--count", "@{u}..HEAD"]));
  } catch { out.upstream = ""; out.ahead = null; }
  return out;
}

const BUCKETS = ["doing", "testing", "blocked", "failed", "todo"];

/** The board from a /catchup read. A failed read says so rather than reading as an empty board. */
export function boardFacts(read) {
  if (!read || !read.ok) return { ok: false, reason: read?.reason || "unreachable", counts: {}, cards: [] };
  const j = read.json || {};
  const cards = [];
  for (const status of BUCKETS) {
    for (const t of Array.isArray(j[status]) ? j[status] : []) {
      cards.push({ id: t.id, title: String(t.title || "").slice(0, 100), status, assignee: t.assignee || "" });
    }
  }
  return { ok: true, reason: "", counts: j.counts || {}, cards: cards.slice(0, 20) };
}

/** @param {{projectDir: string, projectName: string, hubGet: (path: string) => object, now?: number}} a */
export function computeFacts({ projectDir, projectName, hubGet, now = Date.now() }) {
  const gitPart = gitFacts(projectDir);
  let read = null;
  try { read = hubGet(`/catchup?project=${encodeURIComponent(projectName)}`); } catch (e) { read = { ok: false, reason: e?.message }; }
  return { computedAt: new Date(now).toISOString(), ...gitPart, board: boardFacts(read) };
}

/** The facts as the successor and the current-state file both read them: plain, labeled as computed. */
export function renderFacts(facts) {
  if (!facts) return "";
  const rows = [`Computed at handoff (${facts.computedAt}) from git and the board, not written by the model.`];
  if (facts.branch) {
    const sync = facts.upstream
      ? `${facts.ahead} commit(s) ahead of ${facts.upstream}, unpushed`
      : "no upstream configured, so the unpushed count is unknown";
    rows.push(`- Branch ${facts.branch}: ${sync}`);
  } else rows.push("- Branch: not a git checkout or git unavailable");
  const b = facts.board || {};
  if (!b.ok) rows.push(`- Board: could not be read at handoff (${b.reason}); read it yourself before trusting any card claim`);
  else {
    const c = b.counts || {};
    rows.push(`- Board: ${BUCKETS.map(s => `${c[s] || 0} ${s}`).join(", ")}`);
    for (const t of b.cards) rows.push(`  - #${t.id} ${t.status}${t.assignee ? ` (${t.assignee})` : ""}: ${t.title}`);
  }
  return rows.join("\n");
}

/** ", turn N" only when the number is a real one: a state derived at handoff carries a placeholder. */
export function stateTurnLabel(state) {
  const turn = state?.cursor?.turn;
  const derived = String(state?.notes || "").startsWith(DERIVED_NOTE);
  return Number.isInteger(turn) && turn > 0 && !derived ? `, turn ${turn}` : "";
}

/** The successor's facts block; the cap warning rides only the claiming session, once per handoff. */
export function handoffFactsBlock(handoff, claimed, clean = (x) => x) {
  if (!handoff?.facts) return "";
  let out = `## Facts computed at handoff (git and board, not model-written)\n${clean(renderFacts(handoff.facts))}\n`;
  if (handoff.currentStatePath) out += `Read first: ${clean(handoff.currentStatePath)}\n`;
  if (claimed && handoff.memoryWarning) out += `${clean(handoff.memoryWarning)}\n`;
  return `${out}\n`;
}
