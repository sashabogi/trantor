#!/usr/bin/env node
// trantor SessionStart hook — Kimi Code port. Every session auto-registers with the hub and gets
// the live roster + project catch-up + any pending handoff delivered into context. Kimi differences
// from the Claude version:
//   • stdout is emitted as PLAIN TEXT (Kimi has no documented hookSpecificOutput envelope; exit-0
//     stdout may be appended to context).
//   • The same text is ALSO stashed to ~/.agent-bus/kimi-startup-<session>.txt; prompt-focus.mjs
//     injects it on the first real user prompt (UserPromptSubmit stdout is documented to append).
//   • No sessionTitle / systemMessage (unsupported); the user banner folds into the context text.
//   • Kimi never fires SessionStart with source="compact" → a pending handoff is always CLAIMED
//     (unless TRANTOR_NO_CLAIM=1 — used by throwaway `kimi -p` recaps).
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { readPayload, payloadCwd, isHomeSession, identity, relayUrl, jget, jpost, sanitize, debugHook, writeStash, nowSec } from "./lib/common.mjs";
import { findWire } from "./lib/handoff.mjs";
import { updateAvailable, maybeNotifyDesktop, readConfig } from "../../hooks/lib/update-check.mjs";
import { maybeCheckBalances } from "../../hooks/lib/balance-check.mjs";

// Load the most recent UNCONSUMED handoff for this project. `claim` marks it consumed so exactly
// one session takes it. consumedBy records WHO took it (session id + wire path) so baton-close can
// watch for the fresh session's first turn before closing the original window.
function loadPendingHandoff(projectName, { claim = true, freshSession = null } = {}) {
  try {
    const dir = join(homedir(), ".agent-bus", "handoffs");
    if (!existsSync(dir)) return null;
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

let ctx = "";
let banner = "";
let session = "";
try {
  const payload = await readPayload();
  debugHook("SessionStart", payload);
  const projectDir = payloadCwd(payload);
  if (isHomeSession(projectDir)) {
    process.stderr.write("[trantor] session outside a project (or home dir) — not registering on the bus (set RELAY_SESSION to opt in)\n");
    process.exit(0);
  }
  const id = identity(projectDir);
  session = id.session;
  const project = id.project;
  const sessionId = String(payload.session_id || "");
  const url = relayUrl();

  // register self + post an initial presence status (no LLM turn — instant for others to read).
  // llm/model: Kimi's SessionStart payload carries `model` directly (live-captured 2026-08-07:
  // "kimi-code/k3") — Claude has to tail the transcript for this; here it's free.
  await jpost(`${url}/register`, { session, project, status: `active in ${project}`,
    llm: "kimi", model: String(payload.model || "") });

  // fetch roster of OTHER online sessions
  let peers = [];
  try { peers = (await jget(`${url}/peers`)).peers || []; } catch {}
  const others = peers.filter(p => p.online && p.session !== session);

  process.stderr.write(`[trantor] registered as ${session} -> ${url} (${others.length} other live session(s))\n`);

  if (others.length > 0) {
    ctx += `<trantor session="${session}" hub="${url}">\n`;
    ctx += `You are connected to Trantor (the cross-agent session bus) as "${session}". Other LIVE agent sessions are running right now:\n`;
    for (const p of others) ctx += `- ${sanitize(p.session)}\n`;
    ctx += `Use the relay MCP tools (relay_peers, relay_send, relay_inbox, relay_wait) to coordinate with them — hand off work, check for overlap before editing shared files, or ask another session for help. If a sibling session is touching the same project, coordinate before making conflicting changes.\n`;
    ctx += `</trantor>\n`;
  }

  // CATCH-UP: reconcile with the project's living board before doing anything (see the Claude port).
  try {
    const cu = await jget(`${url}/catchup?project=${encodeURIComponent(project)}`).catch(() => null);
    let gitlog = "";
    try { gitlog = execSync(`git -C ${JSON.stringify(projectDir)} log --oneline -5 2>/dev/null`, { encoding: "utf8", timeout: 2500 }).trim(); } catch {}
    if ((cu && cu.total > 0) || gitlog) {
      const line = (arr) => (arr || []).map(t => `#${t.id} ${String(t.title).slice(0, 72)}${t.assignee ? ` @${t.assignee}` : ""}`).join("\n  ");
      ctx += `<trantor-project-state project="${sanitize(project)}">\n`;
      ctx += `📋 **Catching up on the continuous "${sanitize(project)}" board** (this project's living record across all sessions — read it before starting; don't duplicate done work).\n`;
      if (cu && cu.brief) ctx += `\n**Brief:** ${sanitize(cu.brief)}\n`;
      if (cu && cu.total > 0) {
        const c = cu.counts;
        ctx += `\n**Cards:** ${cu.total} total — ${c.done} done · ${c.doing} doing · ${c.testing} testing · ${c.todo} todo · ${c.failed} failed · ${c.blocked} blocked.\n`;
        if (cu.doing?.length)   ctx += `\n_In progress:_\n  ${sanitize(line(cu.doing))}\n`;
        if (cu.testing?.length) ctx += `\n_In testing:_\n  ${sanitize(line(cu.testing))}\n`;
        if (cu.failed?.length)  ctx += `\n_Failed (needs attention):_\n  ${sanitize(line(cu.failed))}\n`;
        if (cu.blocked?.length) ctx += `\n_Blocked:_\n  ${sanitize(line(cu.blocked))}\n`;
        if (cu.todo?.length)    ctx += `\n_Queued (todo):_\n  ${sanitize(line(cu.todo))}\n`;
        if (cu.recentDone?.length) ctx += `\n_Recently done:_\n  ${sanitize(line(cu.recentDone))}\n`;
        const stuck = (c.doing || 0) + (c.testing || 0) + (c.stale || 0);
        if (stuck >= 4 || (c.stale || 0) > 0) ctx += `\n🧠 **${stuck} card(s) look stuck** (doing/testing/stale). Some may already be shipped. Run \`trantor reconcile\` — it checks git + memory (cheap model), closes anything already done so you don't re-do it, and stales what's abandoned. Preview first; \`--yes\` applies.\n`;
      }
      if (gitlog) ctx += `\n**Recent commits:**\n\`\`\`\n${sanitize(gitlog)}\n\`\`\`\n`;
      ctx += `\nFor a synthesized "where are we" narrative on demand, run \`trantor catchup\`.\n`;
      ctx += `</trantor-project-state>\n`;
      process.stderr.write(`[trantor] injected project-state catch-up for ${project} (${cu?.total || 0} cards)\n`);
    }
  } catch {}

  // Update available? (kimi-appropriate update instructions — the Claude text would mislead here.)
  try {
    const upd = await updateAvailable();
    if (upd.available) {
      if (readConfig().updateDesktopNotify === true) maybeNotifyDesktop(upd);
      banner = `🟠 Trantor update available: ${upd.installed} → ${upd.latest}  ·  update with: npm i -g trantor@${upd.latest} + reinstall the plugin (/plugins install)`;
      ctx += `<trantor-update installed="${sanitize(upd.installed)}" latest="${sanitize(upd.latest)}">\n`;
      ctx += `⬆️ **A newer Trantor is available — ${sanitize(upd.installed)} → ${sanitize(upd.latest)}.** Tell the user, and offer the update: \`npm i -g trantor@${sanitize(upd.latest)}\` (CLI), then reinstall this Kimi plugin (\`/plugins install <source>\`) since plugin installs are snapshots, then start a new session.\n`;
      ctx += `</trantor-update>\n`;
      process.stderr.write(`[trantor] update available: ${upd.installed} -> ${upd.latest}\n`);
    }
  } catch {}

  // Provider credit low? (session env has the keys; throttled + fail-silent)
  try {
    const bal = await maybeCheckBalances();
    if (bal.low && bal.low.length) {
      const line = `🟠 Provider credit low — refill soon: ${bal.low.map(l => l.line).join("  ·  ")}  ·  check: trantor balances`;
      banner = banner ? `${banner}\n${line}` : line;
      ctx += `<trantor-balance-low>\n⚠️ ${bal.low.length} provider(s) low on prepaid credit: ${sanitize(bal.low.map(l => l.line).join("; "))}. Tell the user to refill before relying on those providers for a build.\n</trantor-balance-low>\n`;
      process.stderr.write(`[trantor] low balance: ${bal.low.map(l => l.label).join(", ")}\n`);
    }
  } catch {}

  // Pending handoff? This fresh window takes over (always claim — Kimi has no compact-sourced
  // SessionStart). TRANTOR_NO_CLAIM=1 shows it without consuming (throwaway `kimi -p` recaps).
  const claim = process.env.TRANTOR_NO_CLAIM !== "1";
  const handoff = loadPendingHandoff(basename(projectDir), {
    claim,
    freshSession: { session_id: sessionId, transcript_path: findWire(projectDir, sessionId) },
  });
  if (handoff) {
    process.stderr.write(`[trantor] ${claim ? "loaded" : "showing (no-claim)"} pending handoff ${handoff.id}\n`);
    ctx += `<trantor-handoff id="${sanitize(handoff.id)}" from="${sanitize(handoff.machine)}" trigger="${sanitize(handoff.trigger)}">\n`;
    ctx += `🔄 **You are taking over from a prior session that hit its context limit (or passed the baton).** This is a fresh full window. Resume the work below — the prior session's summary, git state, and a pointer to its full transcript follow. Continue from "OPEN THREADS & NEXT STEPS"; do not restart from scratch. Start by briefly recapping to the user what the previous session was doing and where you will continue.\n\n`;
    if (Array.isArray(handoff.verifyGates) && handoff.verifyGates.length) {
      ctx += `## ⚠️ UNVERIFIED — verify before shipping (${handoff.verifyGates.length})\n`;
      ctx += `The prior session flagged these as NOT independently verified. Do NOT commit or ship the related work until each is verified (or explicitly waived WITH the user) — passing the author's own tests is not verification. Resolve via the \`relay_verify_gate\` tool (action "resolve") once checked.\n`;
      for (const g of handoff.verifyGates) {
        ctx += `- **#${sanitize(String(g.id))}: ${sanitize(g.claim)}**${g.why ? ` — ${sanitize(g.why)}` : ""}`;
        if (g.howToVerify) ctx += `\n    how to verify: ${sanitize(g.howToVerify)}`;
        ctx += `\n`;
      }
      ctx += `\n`;
    }
    ctx += `## Handoff summary\n${sanitize(handoff.summary)}\n`;
    if (handoff.gitStatus) ctx += `\n## Git working-tree at handoff\n\`\`\`\n${sanitize(handoff.gitStatus)}\n\`\`\`\n`;
    if (handoff.transcript_path) ctx += `\n_Full prior transcript: ${sanitize(handoff.transcript_path)}_\n`;
    ctx += `</trantor-handoff>\n`;
  }
} catch (err) {
  process.stderr.write(`[trantor] kimi sessionstart error: ${err?.message || err}\n`);
}

const out = (banner ? banner + "\n\n" : "") + ctx;
if (out.trim()) {
  // Path 1: plain stdout (may be appended to context by Kimi directly).
  try { process.stdout.write(out); } catch {}
  // Path 2 (guaranteed): stash for prompt-focus.mjs to inject on the session's first user prompt.
  if (session) writeStash(session, out);
}
process.exit(0);
