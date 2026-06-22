// trantor sub-agent manifest — reconstruct what a session's sub-agents (Agent/Task tool,
// Workflow swarms, agent-teams) were doing, purely from on-disk transcripts. No new runtime
// instrumentation: it's a READ-TIME projection of primary sources, so it can't drift and the
// successor can re-derive it itself (that's the point — live-primary, snapshot-as-fallback).
//
// Born from the 2026-06-21 incident: an auto baton-pass SIGKILLed a session mid 2-agent build.
// The fresh session had no idea two agents were even running, and one agent's COMPLETED 30KB
// implementation had been clobbered on disk to a 17-byte stub by the kill — so the successor
// rebuilt it from scratch believing "nothing survived." The manifest surfaces exactly that:
// what each agent was tasked with, whether it returned, what it wrote, and — via a disk
// reconcile — whether the files it wrote still survive or look clobbered.
//
// Four primary sources (all already on disk under ~/.claude/projects/<proj>/<sid>/):
//   1. subagents/*.meta.json        → {name, agentType, description (the task), toolUseId}
//   2. parent <sid>.jsonl           → tool_result ids ⇒ which agents RETURNED (completed)
//   3. each subagents/agent-*.jsonl → files written, last activity, the result it reported
//   4. disk reconcile               → agent wrote X@N bytes; does X still exist & match? (suspect)
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { homedir } from "node:os";

const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

function parseLines(path) {
  let raw; try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const out = [];
  for (const ln of raw.split("\n")) { if (!ln) continue; try { out.push(JSON.parse(ln)); } catch {} }
  return out;
}

// Resolve a bare session id to its transcript path by scanning ~/.claude/projects/*/<sid>.jsonl.
export function resolveTranscriptForSid(sid) {
  if (!sid) return "";
  const base = join(homedir(), ".claude", "projects");
  try {
    for (const proj of readdirSync(base)) {
      const p = join(base, proj, `${sid}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {}
  return "";
}

// Walk subagents/ (recursing into workflows/<wf>/) collecting every *.meta.json paired with its
// .jsonl. `workflow` is the workflow id when the agent lives under workflows/<wf>/, else null.
function collectMetas(subdir) {
  const out = [];
  const walk = (dir, workflow) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, e.name === "workflows" ? workflow : e.name); continue; }
      if (!e.name.endsWith(".meta.json")) continue;
      let meta; try { meta = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
      out.push({ ...meta, jsonlPath: p.replace(/\.meta\.json$/, ".jsonl"), workflow: workflow || null });
    }
  };
  walk(subdir, null);
  return out;
}

function shortPath(absPath, projectRoot) {
  try {
    if (projectRoot && absPath.startsWith(projectRoot)) return relative(projectRoot, absPath) || absPath;
  } catch {}
  return absPath.split("/").slice(-4).join("/");
}

// Does the file the agent wrote still survive intact? agentBytes = the size the agent last wrote.
// suspect = the file is gone, or shrank far below what the agent wrote (clobbered, e.g. by a kill).
function reconcileFile(absPath, agentBytes, projectRoot) {
  let onDiskNow = null, suspect = false;
  try {
    if (existsSync(absPath)) {
      onDiskNow = statSync(absPath).size;
      if (agentBytes > 200 && onDiskNow < Math.min(agentBytes * 0.5, agentBytes - 200)) suspect = true;
    } else {
      onDiskNow = 0;
      suspect = agentBytes > 200; // the agent wrote real content but the file is gone
    }
  } catch {}
  return { path: shortPath(absPath, projectRoot), agentBytes, onDiskNow, suspect };
}

function analyzeAgent(meta, completedIds, projectRoot) {
  const wrote = new Map(); // absPath → last-write byte length
  let lastMs = 0, result = "";
  for (const r of parseLines(meta.jsonlPath)) {
    const ts = r.timestamp ? Date.parse(r.timestamp) || 0 : 0;
    if (ts > lastMs) lastMs = ts;
    const c = r?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === "tool_use" && EDIT_TOOLS.test(b.name) && b.input?.file_path) {
        const content = b.input.content ?? b.input.new_string ?? "";
        wrote.set(b.input.file_path, content.length); // last write to a path wins
      }
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) result = b.text.trim();
    }
  }
  const status = meta.toolUseId && completedIds.has(meta.toolUseId) ? "completed" : "in-flight";
  return {
    name: meta.name || basename(meta.jsonlPath).replace(/\.jsonl$/, ""),
    agentType: meta.agentType || "",
    task: meta.description || "",
    workflow: meta.workflow || null,
    status,
    wrote: [...wrote.entries()].map(([p, n]) => reconcileFile(p, n, projectRoot)),
    lastActivity: lastMs ? new Date(lastMs).toISOString() : null,
    lastActivityMs: lastMs,
    transcript: meta.jsonlPath,
    result: result.slice(0, 400),
  };
}

// Derive the full manifest for a session from its parent transcript path. projectRoot (the repo
// dir) is used only to shorten displayed file paths. Returns { sessionId, subagents[], counts }.
export function deriveSubagentManifest(parentTranscript, { projectRoot } = {}) {
  const out = { sessionId: "", subagents: [], counts: { total: 0, completed: 0, inFlight: 0, suspectFiles: 0 } };
  try {
    if (!parentTranscript || !existsSync(parentTranscript)) return out;
    const sid = basename(parentTranscript).replace(/\.jsonl$/i, "");
    out.sessionId = sid;
    const subdir = join(dirname(parentTranscript), sid, "subagents");
    if (!existsSync(subdir)) return out;

    // (2) parent transcript → tool_result ids = agents that returned a result.
    const completedIds = new Set();
    for (const r of parseLines(parentTranscript)) {
      const c = r?.message?.content;
      if (Array.isArray(c)) for (const b of c) if (b?.type === "tool_result" && b.tool_use_id) completedIds.add(b.tool_use_id);
    }

    const metas = collectMetas(subdir);
    out.subagents = metas.map((m) => analyzeAgent(m, completedIds, projectRoot))
      .sort((a, b) => (a.lastActivityMs || 0) - (b.lastActivityMs || 0));

    out.counts.total = out.subagents.length;
    out.counts.completed = out.subagents.filter((s) => s.status === "completed").length;
    out.counts.inFlight = out.subagents.filter((s) => s.status === "in-flight").length;
    out.counts.suspectFiles = out.subagents.reduce((n, s) => n + s.wrote.filter((w) => w.suspect).length, 0);
  } catch {}
  return out;
}

// Human-readable rendering (the `trantor agents` output, and the handoff snapshot block).
export function formatSubagentManifest(m, { heading = true } = {}) {
  if (!m || !m.subagents.length) return "No sub-agents found for this session.";
  const L = [];
  if (heading) {
    L.push(`Sub-agent manifest — ${m.counts.total} agents (${m.counts.completed} completed, ${m.counts.inFlight} in-flight at handoff)`);
    if (m.counts.suspectFiles) {
      L.push(`⚠️  ${m.counts.suspectFiles} file(s) an agent wrote look CLOBBERED on disk (gone or far smaller than written) — RECOVER from the agent's transcript before assuming the work was never done.`);
    }
  }
  for (const s of m.subagents) {
    const badge = s.status === "completed" ? "✅ completed" : "🛑 IN-FLIGHT at handoff";
    L.push("");
    L.push(`• ${s.name}  [${s.agentType}]${s.workflow ? ` · wf:${s.workflow}` : ""}  ${badge}`);
    if (s.task) L.push(`    task: ${s.task}`);
    if (s.wrote.length) {
      for (const w of s.wrote) {
        const size = w.onDiskNow != null ? (w.onDiskNow === 0 && w.suspect ? "MISSING" : `${w.onDiskNow}B on disk`) : "?";
        const flag = w.suspect ? `   ⚠️ SUSPECT — agent wrote ${w.agentBytes}B, recover from transcript` : "";
        L.push(`    wrote: ${w.path} (${size})${flag}`);
      }
    } else {
      L.push(`    wrote: (no file edits)`);
    }
    L.push(`    transcript: ${s.transcript}`);
  }
  L.push("");
  L.push(`Read any agent's transcript for its full reasoning/sourcing before trusting OR discarding its work.`);
  return L.join("\n");
}
