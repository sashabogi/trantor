#!/usr/bin/env node
// trantor SessionStart hook — every session auto-registers with the hub and
// gets a roster of OTHER live sessions injected into context, so independent
// sessions discover each other automatically (locally or across machines).
//
// Config resolution (first hit wins):
//   env RELAY_URL  →  ~/.agent-bus/config.json {"url": "..."}  →  http://127.0.0.1:4477
// Identity: env RELAY_SESSION  →  "<hostname>:<basename(cwd)>"  (stable per project/machine)
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync } from "node:child_process";
import { resolveProject, hostId } from "../lib/project.mjs";
import { formatSubagentManifest } from "../lib/subagent-manifest.mjs";
import { updateAvailable, maybeNotifyDesktop, readConfig } from "./lib/update-check.mjs";
import { maybeCheckBalances } from "./lib/balance-check.mjs";

// Load the most recent UNCONSUMED handoff for this project (written by precompact.mjs
// / the heartbeat early-warning). `claim` marks it consumed so exactly one session
// takes it. A compaction-triggered SessionStart (source="compact") is the SAME session
// that just wrote the handoff for a FRESH window to pick up — it may show the summary
// for continuity but must NOT claim it, or it steals the handoff from the new window.
function loadPendingHandoff(projectName, { claim = true, freshSession = null } = {}) {
  try {
    const dir = join(homedir(), ".agent-bus", "handoffs");
    if (!existsSync(dir)) return null;
    // Match ONLY this project's handoffs: "<projectName>-<numeric stamp>.json".
    // NOT a loose startsWith() — that also caught leaked test fixtures like
    // "trantor-handoff-61385-….json" for project "trantor". And sort by the numeric
    // stamp (newest first), NOT lexicographically — string sort ranks a letter prefix
    // ("…-handoff-…") above a digit one, so it could pick a stale/wrong handoff.
    const re = new RegExp("^" + projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)\\.json$");
    const files = readdirSync(dir)
      .map(f => { const m = re.exec(f); return m ? { f, stamp: Number(m[1]) } : null; })
      .filter(Boolean)
      .sort((a, b) => b.stamp - a.stamp)
      .map(x => x.f);
    for (const f of files) {
      const p = join(dir, f);
      const rec = JSON.parse(readFileSync(p, "utf8"));
      if (!rec.consumed) {
        if (claim) {
          // `consumed` means "injected into THIS fresh session's first-turn context" — which happens
          // here at hook time, BEFORE the model has actually read anything. So we also record WHO is
          // taking over (session id + transcript path) and when. baton-close watches that transcript
          // for the fresh session's first assistant turn and only then closes the original window —
          // otherwise it pulled the original ~4s after the fresh window booted, "before it even read
          // the handoff."
          rec.consumed = true;
          rec.consumedAt = nowSec();
          if (freshSession && (freshSession.session_id || freshSession.transcript_path)) {
            rec.consumedBy = {
              session_id: freshSession.session_id || "",
              transcript_path: freshSession.transcript_path || "",
            };
          }
          writeFileSync(p, JSON.stringify(rec, null, 2));
        }
        return rec;
      }
    }
  } catch {}
  return null;
}

function nowSec() { try { return Number(execSync("date +%s", { encoding: "utf8" }).trim()) || 0; } catch { return 0; } }

function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL;
  try {
    const cfg = join(homedir(), ".agent-bus", "config.json");
    if (existsSync(cfg)) { const u = JSON.parse(readFileSync(cfg, "utf8")).url; if (u) return u; }
  } catch {}
  return "http://127.0.0.1:4477";
}
function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 100); });
}
async function jget(u) { const r = await fetch(u, { signal: AbortSignal.timeout(2500) }); return r.json(); }
async function jpost(u, b) { return fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(2500) }); }

// Strip control chars from untrusted injected text so the hook's JSON stdout (which
// Claude Code parses) stays valid. Keeps tab/newline/CR; replaces 0x00-0x1F (minus
// those), DEL, and the JS line/paragraph separators.
function sanitize(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0);
    const bad = (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f || c === 0x2028 || c === 0x2029;
    out += bad ? " " : ch;
  }
  return out;
}

let additionalContext = "";
let userBanner = "";   // shown to the USER in-terminal via the hook's `systemMessage` (not model-only context)
try {
  let source = "", stdinObj = {};
  try { stdinObj = JSON.parse((await readStdin()) || "{}"); source = stdinObj.source || ""; } catch {}
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Sessions started in the home directory itself aren't project work — registering
  // them spawns a phantom "<username>" project board on the dashboard. Set
  // RELAY_SESSION (or RELAY_PROJECT) to deliberately put a home-dir session on the bus.
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && projectDir === homedir()) {
    process.stderr.write("[trantor] session in the home directory — not registering on the bus (set RELAY_SESSION to opt in)\n");
    process.stdout.write("{}");
    process.exit(0);
  }
  const project = resolveProject(projectDir);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);
  const url = relayUrl();

  // register self + post an initial presence status (no LLM turn — instant for others to read)
  await jpost(`${url}/register`, { session, project, status: `active in ${project}` }).catch(() => {});

  // fetch roster of OTHER online sessions
  let peers = [];
  try { peers = (await jget(`${url}/peers`)).peers || []; } catch {}
  const others = peers.filter(p => p.online && p.session !== session);

  process.stderr.write(`[trantor] registered as ${session} -> ${url} (${others.length} other live session(s))\n`);

  if (others.length > 0) {
    additionalContext += `<trantor session="${session}" hub="${url}">\n`;
    additionalContext += `You are connected to Trantor (the cross-agent session bus) as "${session}". Other LIVE agent sessions are running right now:\n`;
    for (const p of others) additionalContext += `- ${sanitize(p.session)}\n`;
    additionalContext += `Use the relay MCP tools (relay_peers, relay_send, relay_inbox, relay_wait) to coordinate with them — hand off work, check for overlap before editing shared files, or ask another session for help. If a sibling session is touching the same project, coordinate before making conflicting changes.\n`;
    additionalContext += `</trantor>\n`;
  }

  // CATCH-UP: a project is a DURABLE, continuous lane — not a session. Before doing
  // anything, this session reconciles with the living board: what's been built, what's
  // in flight, what's queued, plus the latest commits. So a fresh window resumes the
  // SAME project where it stands instead of starting blind. Cheap + LLM-free.
  try {
    const cu = await jget(`${url}/catchup?project=${encodeURIComponent(project)}`).catch(() => null);
    let gitlog = "";
    try { gitlog = execSync(`git -C ${JSON.stringify(projectDir)} log --oneline -5 2>/dev/null`, { encoding: "utf8", timeout: 2500 }).trim(); } catch {}
    if ((cu && cu.total > 0) || gitlog) {
      const line = (arr) => (arr || []).map(t => `#${t.id} ${String(t.title).slice(0, 72)}${t.assignee ? ` @${t.assignee}` : ""}`).join("\n  ");
      additionalContext += `<trantor-project-state project="${sanitize(project)}">\n`;
      additionalContext += `📋 **Catching up on the continuous "${sanitize(project)}" board** (this project's living record across all sessions — read it before starting; don't duplicate done work).\n`;
      if (cu && cu.brief) additionalContext += `\n**Brief:** ${sanitize(cu.brief)}\n`;
      if (cu && cu.total > 0) {
        const c = cu.counts;
        additionalContext += `\n**Cards:** ${cu.total} total — ${c.done} done · ${c.doing} doing · ${c.testing} testing · ${c.todo} todo · ${c.failed} failed · ${c.blocked} blocked.\n`;
        if (cu.doing?.length)   additionalContext += `\n_In progress:_\n  ${sanitize(line(cu.doing))}\n`;
        if (cu.testing?.length) additionalContext += `\n_In testing:_\n  ${sanitize(line(cu.testing))}\n`;
        if (cu.failed?.length)  additionalContext += `\n_Failed (needs attention):_\n  ${sanitize(line(cu.failed))}\n`;
        if (cu.blocked?.length) additionalContext += `\n_Blocked:_\n  ${sanitize(line(cu.blocked))}\n`;
        if (cu.todo?.length)    additionalContext += `\n_Queued (todo):_\n  ${sanitize(line(cu.todo))}\n`;
        if (cu.recentDone?.length) additionalContext += `\n_Recently done:_\n  ${sanitize(line(cu.recentDone))}\n`;
      }
      if (gitlog) additionalContext += `\n**Recent commits:**\n\`\`\`\n${sanitize(gitlog)}\n\`\`\`\n`;
      additionalContext += `\nFor a synthesized "where are we" narrative on demand, run \`trantor catchup\`.\n`;
      additionalContext += `</trantor-project-state>\n`;
      process.stderr.write(`[trantor] injected project-state catch-up for ${project} (${cu?.total || 0} cards)\n`);
    }
  } catch {}

  // Update available? Surface it the way a terminal tool should — an in-terminal `systemMessage`
  // line the USER sees at session start (NOT a macOS desktop popup, which macOS misattributes to
  // Script Editor and which fires off-screen). It shows every session while an update is pending and
  // auto-clears the moment they update (updateAvailable() flips false) — a persistent-until-resolved
  // reminder, like the built-in MCP-disconnected indicator. The model also gets the <trantor-update>
  // context block so it can give the exact commands on request. Desktop notification is now OPT-IN
  // (config.updateDesktopNotify:true) for anyone who genuinely wants the OS-level ping.
  // Throttled + fail-silent; most starts do zero network (6h TTL cache). Disable: TRANTOR_NO_UPDATE_CHECK.
  try {
    const upd = await updateAvailable();
    if (upd.available) {
      if (readConfig().updateDesktopNotify === true) maybeNotifyDesktop(upd);   // opt-in only
      // Bold-orange ANSI so it's not lost in Claude Code's dim systemMessage styling; a leading
      // 🟠 emoji anchor keeps it visibly colored even on a terminal that ignores the ANSI (so it
      // can never silently fall back to low-contrast gray). \x1b[1;38;5;208m = bold orange, \x1b[0m resets.
      const O = "\x1b[1;38;5;208m", R = "\x1b[0m";
      userBanner = `🟠 ${O}Trantor update available: ${upd.installed} → ${upd.latest}${R}  ·  update with:  ${O}claude plugin update trantor@trantor${R}`;
      additionalContext += `<trantor-update installed="${sanitize(upd.installed)}" latest="${sanitize(upd.latest)}">\n`;
      additionalContext += `⬆️ **A newer Trantor is available — ${sanitize(upd.installed)} → ${sanitize(upd.latest)}.** Tell the user, and offer the update: \`claude plugin update trantor@trantor\` (plugin) + \`npm i -g trantor@${sanitize(upd.latest)}\` (CLI), then restart to apply.\n`;
      additionalContext += `</trantor-update>\n`;
      process.stderr.write(`[trantor] update available: ${upd.installed} -> ${upd.latest}\n`);
    }
  } catch {}

  // Provider credit low? The session env has the keys (the hub doesn't), so check + push the snapshot
  // here and warn in-terminal so you refill BEFORE a build stalls. Throttled (3h TTL) + 4s-capped +
  // fail-silent — most starts do zero network. Disable: TRANTOR_NO_BALANCE_CHECK=1.
  try {
    const bal = await maybeCheckBalances();
    if (bal.low && bal.low.length) {
      const O = "\x1b[1;38;5;208m", R = "\x1b[0m";
      const line = `🟠 ${O}Provider credit low — refill soon:${R} ${bal.low.map(l => l.line).join("  ·  ")}  ·  check:  ${O}trantor balances${R}`;
      userBanner = userBanner ? `${userBanner}\n${line}` : line;
      additionalContext += `<trantor-balance-low>\n⚠️ ${bal.low.length} provider(s) low on prepaid credit: ${sanitize(bal.low.map(l => l.line).join("; "))}. Tell the user to refill before relying on those providers for a build.\n</trantor-balance-low>\n`;
      process.stderr.write(`[trantor] low balance: ${bal.low.map(l => l.label).join(", ")}\n`);
    }
  } catch {}

  // Pending handoff? A prior session hit the context limit and left a handoff for this
  // project — take over with this fresh full window instead of starting cold. On a
  // compaction-triggered start, DON'T claim it (that's the same session that wrote it;
  // claiming would steal it from the freshly-spawned window) — show it for continuity only.
  const isCompact = source === "compact";
  const handoff = loadPendingHandoff(basename(projectDir), {
    claim: !isCompact,
    freshSession: { session_id: stdinObj.session_id || "", transcript_path: stdinObj.transcript_path || "" },
  });
  if (handoff) {
    process.stderr.write(`[trantor] ${isCompact ? "showing (not claiming, compact)" : "loaded"} pending handoff ${handoff.id}\n`);
    additionalContext += `<trantor-handoff id="${sanitize(handoff.id)}" from="${sanitize(handoff.machine)}" trigger="${sanitize(handoff.trigger)}">\n`;
    additionalContext += `🔄 **You are taking over from a prior session that hit its context limit.** This is a fresh full window. Resume the work below — the prior session's summary, git state, and a pointer to its full transcript (searchable; Foundation/Gaia has it ingested) follow. Continue from "OPEN THREADS & NEXT STEPS"; do not restart from scratch.\n\n`;
    // Verification gates FIRST — these are structured "must verify before shipping" claims the prior
    // session couldn't independently prove. They go above the summary on purpose: a safety-critical
    // check must not be skimmed past (the lesson of the lost "verify Gail coefficients" intent).
    if (Array.isArray(handoff.verifyGates) && handoff.verifyGates.length) {
      additionalContext += `## ⚠️ UNVERIFIED — verify before shipping (${handoff.verifyGates.length})\n`;
      additionalContext += `The prior session flagged these as NOT independently verified. Do NOT commit or ship the related work until each is verified (or explicitly waived WITH the user) — passing the author's own tests is not verification. Resolve via the \`relay_verify_gate\` tool (action "resolve") once checked.\n`;
      for (const g of handoff.verifyGates) {
        additionalContext += `- **#${sanitize(String(g.id))}: ${sanitize(g.claim)}**${g.why ? ` — ${sanitize(g.why)}` : ""}`;
        if (g.howToVerify) additionalContext += `\n    how to verify: ${sanitize(g.howToVerify)}`;
        additionalContext += `\n`;
      }
      additionalContext += `\n`;
    }
    additionalContext += `## Handoff summary\n${sanitize(handoff.summary)}\n`;
    if (handoff.gitStatus) additionalContext += `\n## Git working-tree at handoff\n\`\`\`\n${sanitize(handoff.gitStatus)}\n\`\`\`\n`;
    // Sub-agent manifest: LIVE-primary, snapshot-as-fallback. The prior session may have had
    // sub-agents (Agent/Task, Workflow) building things you can't see in its narrative — and a
    // kill can corrupt an agent's finished file on disk. Direct the successor to re-derive LIVE
    // (reconciles against current disk) and trust that over the baked snapshot.
    if (handoff.subagents && handoff.subagents.counts && handoff.subagents.counts.total) {
      const sa = handoff.subagents;
      additionalContext += `\n## Sub-agents the prior session ran (${sa.counts.total}: ${sa.counts.completed} completed, ${sa.counts.inFlight} in-flight at handoff)\n`;
      additionalContext += `**Before continuing, get the LIVE manifest** — run \`trantor agents ${sanitize(handoff.session_id)}\` (or \`trantor agents\` from this project). It re-derives from CURRENT disk, flagging any file an agent finished that was later clobbered — do NOT assume "nothing survived"; recover from the agent's transcript. Trust the live command over the snapshot below.\n`;
      if (sa.counts.suspectFiles) additionalContext += `⚠️ ${sa.counts.suspectFiles} file(s) an agent wrote looked CLOBBERED at handoff time — verify with the live command and recover.\n`;
      additionalContext += `\n\`\`\`\n${sanitize(formatSubagentManifest(sa, { heading: false }))}\n\`\`\`\n`;
    }
    if (handoff.transcript_path) additionalContext += `\n_Full prior transcript: ${sanitize(handoff.transcript_path)}_\n`;
    additionalContext += `</trantor-handoff>\n`;
  }
} catch (err) {
  process.stderr.write(`[trantor] sessionstart error: ${err?.message || err}\n`);
}

// Hook protocol: emit additionalContext (model-facing) via stdout JSON, plus an optional
// `systemMessage` (USER-facing — rendered as a line in the terminal, our update indicator).
// Self-validate so we never emit something Claude Code can't parse — fall back to sanitized, then {}.
function emit(ctx, sysMsg) {
  const obj = {};
  if (ctx) obj.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: ctx };
  if (sysMsg) obj.systemMessage = sysMsg;
  const out = JSON.stringify(obj);
  try { JSON.parse(out); return out; } catch { /* fall through */ }
  try {
    const safe = {};
    if (ctx) safe.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: sanitize(ctx) };
    if (sysMsg) safe.systemMessage = sanitize(sysMsg);
    return JSON.stringify(safe);
  } catch { return "{}"; }
}
process.stdout.write(emit(additionalContext, userBanner));
process.exit(0);
