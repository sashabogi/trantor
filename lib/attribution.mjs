import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readReceipts, shaMatches } from "./harvest.mjs";

const SEAT = /^(glm|codex|kimi|openrouter|claude|gemini|deepseek|opencode|qwen|ollama)(-\d+)?$/i;
const RULES = ["harvest", "card", "author", "claude", "unknown"];
const MARKER = "TRANTOR-COMMIT";
const VERSION = 2;

export function identity(name, seatOnly = false) {
  const instance = String(name || "").trim().split(":")[0];
  if (!instance || (seatOnly && !SEAT.test(instance))) return null;
  // a non-seat assignee is an orchestrator session (<host>:<project>), same agent as the Claude-trailer rule
  return { agent: SEAT.test(instance) ? instance.toLowerCase().replace(/-\d+$/, "") : "orchestrator", instance };
}

function uniqueIdentity(names) {
  const choices = names.filter(Boolean);
  if (!choices.length) return null;
  return choices.every(row => row.instance === choices[0].instance) ? choices[0] : null;
}

export function resolveCommit(commit, { receipts, cards, branches }) {
  const harvested = receipts.filter(row => shaMatches(row.main, commit.sha));
  const fromHarvest = uniqueIdentity(harvested.map(row => {
    const branch = identity(String(row.branch || "").replace(/^seat\//, ""), true);
    const holders = uniqueIdentity((branches.get(row.seat) || []).map(name => identity(name.replace(/^seat\//, ""), true)));
    return branch || holders || identity(cards.get(Number(row.card)));
  }));
  if (fromHarvest) return { ...fromHarvest, rule: "harvest" };
  const ids = [...commit.subject.matchAll(/#(\d+)\b/g)].map(match => Number(match[1]));
  const fromCard = uniqueIdentity(ids.map(id => identity(cards.get(id))));
  if (fromCard) return { ...fromCard, rule: "card" };
  const author = identity(commit.author, true);
  if (author) return { ...author, rule: "author" };
  if (/^Co-Authored-By:\s*Claude(?:\s|<).*<[^>]+>\s*$/im.test(commit.body)) {
    return { agent: "orchestrator", instance: "orchestrator", rule: "claude" };
  }
  return { agent: "unknown", instance: "unknown", rule: "unknown" };
}

export function parseHistory(raw) {
  const tokens = raw.split("\0");
  const commits = [];
  let current = null;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "" && tokens[i + 1] === MARKER) {
      i++;
      current = { sha: tokens[++i], author: tokens[++i], lastAt: tokens[++i], subject: tokens[++i], body: tokens[++i], paths: [] };
      commits.push(current);
      // Git puts one formatting newline before the first NUL-delimited path.
      if (tokens[i + 1]?.startsWith("\n")) tokens[i + 1] = tokens[i + 1].slice(1);
    } else if (current && tokens[i]) current.paths.push(tokens[i]);
  }
  return commits;
}

export function attributeHistory(commits, evidence) {
  const files = new Map();
  const counts = Object.fromEntries(RULES.map(rule => [rule, 0]));
  const totals = new Map();
  for (const commit of commits) {
    const who = resolveCommit(commit, evidence);
    counts[who.rule]++;
    totals.set(who.agent, (totals.get(who.agent) || 0) + 1);
    for (const path of new Set(commit.paths)) {
      if (!files.has(path)) files.set(path, new Map());
      const agents = files.get(path);
      const row = agents.get(who.agent) || { agent: who.agent, commits: 0, lastAt: commit.lastAt, instances: new Set() };
      row.commits++;
      if (Date.parse(commit.lastAt) > Date.parse(row.lastAt)) row.lastAt = commit.lastAt;
      row.instances.add(who.instance);
      agents.set(who.agent, row);
    }
  }
  const order = (a, b) => b.commits - a.commits || a.agent.localeCompare(b.agent);
  return {
    files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, rows]) => {
      const agents = [...rows.values()].map(row => ({ ...row, instances: [...row.instances].sort() })).sort(order);
      return { path, agents, dominant: agents[0].agent };
    }),
    agents: [...totals].map(([agent, commits]) => ({ agent, commits })).sort(order),
    coverage: { total: commits.length, rules: RULES.map(rule => ({ rule, commits: counts[rule], percent: commits.length ? counts[rule] * 100 / commits.length : 0 })) },
  };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 120000 });
}

export async function projectAttribution({ root, project, loadCards, receipts = readReceipts(project), cacheDir = join(root, ".trantor", "cache"), ref = "HEAD" }) {
  const head = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  const cachePath = join(cacheDir, "attribution.json");
  let cached;
  try { cached = JSON.parse(readFileSync(cachePath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  if (cached?.version === VERSION && cached.head === head && cached.project === project) return cached;
  const commits = parseHistory(git(root, ["log", head, "--name-only", "-z", "--diff-merges=first-parent", `--format=%x00${MARKER}%x00%H%x00%an%x00%cI%x00%s%x00%b` ]));
  const cards = await loadCards();
  const branches = new Map();
  for (const receipt of receipts) {
    if (receipt.branch || !commits.some(commit => shaMatches(receipt.main, commit.sha))) continue;
    try {
      branches.set(receipt.seat, git(root, ["branch", "--list", "seat/*", "--contains", receipt.seat, "--format=%(refname:short)"]).trim().split("\n").filter(Boolean));
    } catch { branches.set(receipt.seat, []); }
  }
  const result = { version: VERSION, project, head, ...attributeHistory(commits, { receipts, cards, branches }) };
  mkdirSync(cacheDir, { recursive: true });
  const temp = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(result));
  renameSync(temp, cachePath);
  return result;
}
