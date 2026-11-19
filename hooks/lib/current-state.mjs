// The project's current-state memory file (#13871): handoffs wrote no memory, so every successor
// read a model summary written at a full context plus whatever dated note the index still named.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { memoryDirectory } from "../../lib/memory-pins.mjs";
import { renderFacts } from "./handoff-facts.mjs";

export const STATE_FILE = "project_current_state.md";
const INDEX_LINE_RE = /\(project_current_state\.md\)/;
const DATED_RE = /^project_session_handoff_.*\.md$/;
const PROGRESS_HEAD = "## Progress";
const PROGRESS_KEEP = 40;
const CAP_WARN_BYTES = 7500;

export const currentStatePath = (projectDir) => join(memoryDirectory(projectDir), STATE_FILE);

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/** The progress lines already in a state file, oldest first, so a rewrite keeps them. */
export function progressLines(text) {
  const at = String(text).indexOf(`\n${PROGRESS_HEAD}`);
  if (at < 0) return [];
  return text.slice(at).split("\n").slice(2).filter(l => l.startsWith("- "));
}

const section = (title, list) => `## ${title}\n${list.length ? list.join("\n") : "- none recorded"}\n`;
const items = (list) => (list || []).map(i => `- ${i.id} ${i.text}`);

function body({ record, facts, progress }) {
  const st = record.state || null;
  const task = st?.task || (/## TASK\s*\n+([^\n]+)/i.exec(record.summary || "") || [])[1] || "not recorded";
  const when = new Date((record.stamp || 0) * 1000 || Date.now()).toISOString();
  return [
    "---", "name: project_current_state",
    `description: Current task, git and board facts, done, in flight and next for ${record.projectName}, rewritten at every handoff`,
    "metadata:", "  node_type: memory", "  type: project", "---",
    `# Current state of ${record.projectName}`,
    `Written by handoff ${record.id} at ${when}. Rewritten at every handoff; the Progress list below is appended as the session works.`, "",
    `## Task\n${task}\n`, `## Facts\n${renderFacts(facts)}\n`,
    section("Done", items(st?.done)), section("In flight", items(st?.in_flight)), section("Next", items(st?.next)),
    `${PROGRESS_HEAD}\n${progress.slice(-PROGRESS_KEEP).join("\n")}`.trimEnd(), "",
  ].join("\n");
}

/** One index line, added if absent, replaced in place if present, extras dropped. */
export function ensureIndexLine(memDir, id) {
  const p = join(memDir, "MEMORY.md");
  const line = `- [Current state](${STATE_FILE}) — task, git and board facts, progress; rewritten at each handoff (${id || "live"})`;
  const lines = read(p).split("\n");
  const first = lines.findIndex(l => INDEX_LINE_RE.test(l));
  const kept = lines.filter((l, i) => i === first || !INDEX_LINE_RE.test(l));
  if (first < 0) { while (kept.length && kept[kept.length - 1] === "") kept.pop(); kept.push(line); }
  else kept[kept.indexOf(lines[first])] = line;
  writeFileSync(p, kept.join("\n").replace(/\n*$/, "\n"));
  return p;
}

/** Dated handoff notes get a superseded line after their frontmatter; never deleted. */
export function supersedeDatedNotes(memDir) {
  const marked = [];
  const note = `> superseded by ${STATE_FILE}`;
  for (const f of existsSync(memDir) ? readdirSync(memDir) : []) {
    if (!DATED_RE.test(f)) continue;
    const p = join(memDir, f), text = read(p);
    if (text.includes(note)) continue;
    const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
    const at = fm ? fm[0].length : 0;
    writeFileSync(p, `${text.slice(0, at)}${note}\n${text.slice(at)}`);
    marked.push(f);
  }
  return marked;
}

/** READ FIRST: always names the current-state file first, never a dated handoff note. */
export function readFirstWith(summary, statePath) {
  const out = [];
  let inSec = false, named = false;
  for (const raw of String(summary || "").split(/\r?\n/)) {
    if (!inSec && /^\s*(?:#{1,6}\s*)?[*_]*read[\s-]?first\b/i.test(raw)) {
      inSec = true; named = true;
      out.push(raw, statePath);
      continue;
    }
    if (inSec && (raw.trim() === "" || /^#{1,6}\s/.test(raw))) inSec = false;
    if (!inSec) { out.push(raw); continue; }
    const cleaned = raw.replace(/\S*project_session_handoff_\S*/g, "");
    const bare = cleaned.replace(/^\s*(?:[-*]|\d+\.)\s*/, "");
    if (cleaned !== raw && !/[\w~/]/.test(bare)) continue;
    out.push(cleaned);
  }
  return named ? out.join("\n") : `${out.join("\n")}\n\n## READ FIRST\n${statePath}`;
}

/** One plain line when the index is near its 8 KB cap, "" otherwise. */
export function memoryCapWarning(memDir) {
  try {
    const size = statSync(join(memDir, "MEMORY.md")).size;
    return size > CAP_WARN_BYTES
      ? `MEMORY.md is ${size} bytes of its 8192 byte cap: the index is near its cap and needs pruning.` : "";
  } catch { return ""; }
}

/** Handoff-time write: file, index line, superseded notes. Mutates `record`; best-effort. */
export function applyCurrentState({ record, projectDir, facts }) {
  try {
    const memDir = memoryDirectory(projectDir), p = join(memDir, STATE_FILE);
    mkdirSync(memDir, { recursive: true });
    writeFileSync(p, body({ record, facts, progress: progressLines(read(p)) }));
    ensureIndexLine(memDir, record.id);
    record.supersededNotes = supersedeDatedNotes(memDir);
    record.currentStatePath = p;
    record.summary = readFirstWith(record.summary, p);
    record.memoryWarning = memoryCapWarning(memDir);
    return p;
  } catch (e) {
    process.stderr.write(`[trantor] handoff current-state skipped: ${e?.message || e}\n`);
    return "";
  }
}

/** In-session progress: one dated line appended to the state file. Creates a skeleton if absent. */
export function appendProgress(projectDir, text, now = new Date()) {
  const memDir = memoryDirectory(projectDir);
  if (!existsSync(memDir)) return false;
  const p = join(memDir, STATE_FILE);
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  const line = `- ${stamp} ${String(text).replace(/\s+/g, " ").slice(0, 200)}`;
  let cur = read(p);
  if (!cur) {
    cur = body({ record: { id: "none yet", projectName: basename(projectDir), stamp: 0 }, facts: null, progress: [] })
      .replace(/Written by handoff .*\n/, "No handoff has run yet; this file holds in-session progress only.\n");
  }
  const lines = progressLines(cur);
  if (lines.includes(line)) return false;
  const head = cur.slice(0, cur.indexOf(PROGRESS_HEAD));
  writeFileSync(p, `${head}${PROGRESS_HEAD}\n${[...lines, line].slice(-PROGRESS_KEEP).join("\n")}\n`);
  if (!INDEX_LINE_RE.test(read(join(memDir, "MEMORY.md")))) ensureIndexLine(memDir, "");
  return true;
}
