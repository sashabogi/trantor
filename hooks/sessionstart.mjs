#!/usr/bin/env node
// trantor SessionStart hook: every session registers with the hub and gets the roster of OTHER
// live sessions injected, so independent sessions discover each other. Config: env RELAY_URL →
// ~/.agent-bus/config.json → 127.0.0.1:4477. Identity: RELAY_SESSION → "<host>:<basename(cwd)>".
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveProject, hostId, resolveHubInfo, knownProjects, nonSeatReason, handoffDir, readOrchSession, writeOrchSession } from "../lib/project.mjs";
import { formatSubagentManifest } from "../lib/subagent-manifest.mjs";
import { updateAvailable, maybeNotifyDesktop, readConfig } from "./lib/update-check.mjs";
import { renderStateBlock } from "./lib/handoff.mjs";
import { maybeCheckBalances } from "./lib/balance-check.mjs";
import { getJSON, signedGet, signedPost, loadIdentity } from "./lib/api.mjs";
import { ledgerPaths, ensureStart, anchorCursor, writeCursor } from "./lib/inbox-ledger.mjs";
import { ensureEnrolled } from "../lib/enroll.mjs";

// Load the most recent UNCONSUMED handoff for this project; `claim` marks it consumed so exactly
// one session takes it. A compact-triggered start is the WRITER: it may show the summary for
// continuity but must NOT claim, or it steals the handoff from the fresh window.
function loadPendingHandoff(projectName, { claim = true, freshSession = null } = {}) {
  try {
    const dir = handoffDir();   // NEVER join(homedir(), …) here: a drill pointed at a temp bus dir must not claim the real handoffs
    if (!existsSync(dir)) return null;
    // Match ONLY "<projectName>-<numeric stamp>.json" (a loose startsWith caught leaked fixtures) and
    // sort by the NUMERIC stamp, newest first (string sort ranks a letter prefix above a digit).
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
          // `consumed` = injected into THIS fresh session's first-turn context, before the model read
          // anything. Record WHO took over: baton-close waits for the successor's first assistant
          // turn in that transcript before closing the original window.
          rec.consumed = true;
          rec.consumedAt = nowSec();
          if (freshSession && (freshSession.session_id || freshSession.transcript_path)) {
            rec.consumedBy = {
              session_id: freshSession.session_id || "",
              transcript_path: freshSession.transcript_path || "",
            };
          }
          // §5 CLAIMED on the machine's ledger (SYSTEM-CONTRACT) and the recap net armed: every prompt
          // before the first Stop carries a recap reminder (prompt-focus), the first Stop marks RECAPPED.
          if (!Array.isArray(rec.states)) rec.states = [];
          rec.states.push({ state: "claimed", ts: nowSec(), by: freshSession?.session_id || "" });
          writeFileSync(p, JSON.stringify(rec, null, 2));
          if (freshSession?.session_id) {
            try {
              // #5645: the mandate rides the stamp too, so prompt-focus's recap reminder pins
              // the SAME rec.mode the injection below announces (attended=WAIT / unattended=RESUME).
              writeFileSync(join(dir, `recap-pending-${String(freshSession.session_id).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`),
                JSON.stringify({ handoffId: rec.id, ts: nowSec(), mode: rec.mode === "unattended" ? "unattended" : "attended" }));
            } catch {}
          }
        }
        return rec;
      }
    }
  } catch {}
  return null;
}

function nowSec() { try { return Number(execSync("date +%s", { encoding: "utf8" }).trim()) || 0; } catch { return 0; } }

function readStdin() {
  return new Promise(res => { let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => (d += c)); process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 100); });
}
// Hub reads/writes through the shared client (TDD §8), ALL signed: writes close the self-asserted
// `from` hole, reads survive RELAY_AUTH=enforce (unsigned, the roster injection was silently dead
// on the remote hub). A down hub returns {ok:false,json:null}; the caller stays alive (fail-open).
async function jget(u, session) { const r = await signedGet(u, { timeoutMs: 2500, session }); return r.ok ? (r.json || {}) : {}; }
async function jpost(u, b, session) { return (await signedPost(u, b, { session, timeoutMs: 2500 })).ok; }

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

// #5645 injection cap: the handoff injection is a POINTER, not a payload (a 22KB record once cost
// ~9% of a fresh window at boot). The writer caps rec.summary at ~4KB (#5648); this reader
// enforces the same bound on older records: strip the verbatim block, cut on a line, point at the file.
const HANDOFF_INJECT_CAP = 4096;
function capHandoffSummary(handoff) {
  let s = String(handoff?.summary || "");
  const marker = s.indexOf("\n---\n## Verbatim recent exchange");
  if (marker > 0) s = s.slice(0, marker);
  if (s.length <= HANDOFF_INJECT_CAP) return s;
  const cut = s.slice(0, HANDOFF_INJECT_CAP);
  const nl = cut.lastIndexOf("\n");
  s = (nl > HANDOFF_INJECT_CAP * 0.6 ? cut.slice(0, nl) : cut).trimEnd();
  let ptr = `\n\n…(summary capped at ${HANDOFF_INJECT_CAP} chars — full record: ${join(handoffDir(), `${handoff.id}.json`)}`;
  if (handoff.transcript_path) ptr += ` · full transcript: ${handoff.transcript_path}`;
  return s + ptr + ")";
}

// Fail-silent wrapper for the optional #4214 resources detection lib (hooks/lib/resources.mjs).
// A throwing detector — or a half-landed lib whose export isn't a function yet — must never break
// session start; this returns dft on any error. The lib is itself fail-silent, this is defense-in-depth.
function safeInv(fn, dft = []) { try { const r = fn(); return r == null ? dft : r; } catch { return dft; } }

// Session title for the picker / --resume / mobile: CC names a session after its FIRST PROMPT, so
// siblings look alike. "<project> · <current work>" from the board makes them distinguishable.
// (No mid-session rename exists, so this reflects state at startup.)
function sessionTitleFrom(project, cu) {
  let work = "";
  if (cu) {
    // prefer real work cards (doing → testing → todo), skipping transient cc-subagent infra cards which
    // would otherwise dominate "most recent" and make every session title noise; then the project brief.
    const real = a => (Array.isArray(a) ? a.filter(t => t.source !== "cc-subagent") : []);
    const first = a => (a.length ? a[0].title : "");
    work = first(real(cu.doing)) || first(real(cu.testing)) || first(real(cu.todo)) || cu.brief || "";
  }
  work = String(work || "").replace(/\s+/g, " ").trim()
    .replace(/^v?\d+\.\d+\.\d+\s*[:—–•·-]\s*/i, "");   // drop a leading release-version prefix (just noise here)
  if (work.length > 44) work = work.slice(0, 43).trimEnd() + "…";
  return sanitize(work ? `${project} · ${work}` : project).slice(0, 90);
}

let additionalContext = "";
let userBanner = "";   // shown to the USER in-terminal via the hook's `systemMessage` (not model-only context)
let sessionTitle = "";  // picker / --resume / mobile title — set to "<project> · <current work>" below
let userTitle = "";     // a title the USER set explicitly (--name / rename); never override it
try {
  let source = "", stdinObj = {};
  try { stdinObj = JSON.parse((await readStdin()) || "{}"); source = stdinObj.source || ""; } catch {}
  userTitle = (stdinObj && stdinObj.session_title) ? String(stdinObj.session_title) : "";   // user already named it
  // input.cwd FIRST, matching hooks/prompt-focus.mjs. When they disagreed, two hooks in ONE
  // session resolved two different projects — and therefore two different hubs — so half a
  // session's work recorded on a hub nobody was reading.
  const projectDir = stdinObj.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // NOT A SEAT: say so, loudly, to BOTH the user and the model. A session started outside a project
  // (home, ~/development, the plugin cache) mints a phantom board on the LOCAL hub if registered,
  // and a stderr line nobody reads left sessions believing they were a seat for an hour (every
  // macOS reboot reopens Terminal in $HOME). So: no registration, and the one command that fixes it.
  const notSeat = nonSeatReason(projectDir);
  if (notSeat) {
    const known = knownProjects();
    const O = "\x1b[1;38;5;208m", R = "\x1b[0m";
    const banner = `🟠 ${O}Not a Trantor seat${R} — ${projectDir} is ${notSeat}. `
      + `It is NOT on the bus: no board, no peers, no inbox. `
      + `Start it from the project directory instead:  ${O}cd <project> && claude${R}`;
    let ctx = `<trantor-not-a-seat cwd="${sanitize(projectDir)}" reason="${sanitize(notSeat)}">\n`;
    ctx += `⚠️ **This session is NOT registered on Trantor.** Its working directory `;
    ctx += `(\`${sanitize(projectDir)}\`) is ${sanitize(notSeat)} — not a project — so no seat was created for it.\n\n`;
    ctx += `**What that means — do not work around it, and do not report the bus as broken:**\n`;
    ctx += `- You have no project board, no peers, and no inbox. \`relay_peers\` will look empty and \`relay_send\` reaches nobody.\n`;
    ctx += `- Messages other sessions address to this project are NOT lost — they are waiting on the hub for a real seat.\n`;
    ctx += `- The hubs are almost certainly healthy. "Trantor is unreachable" is the WRONG diagnosis here; the right one is "this window is in the wrong directory".\n\n`;
    ctx += `**Tell the user this, in your first reply, before doing anything else.** The fix is to close this window and start Claude from the project directory (\`cd <project> && claude\`), which is what makes it a seat. A session can also be forced onto the bus with \`RELAY_PROJECT=<project> claude\`, but only when there is a reason it cannot run from the directory itself.\n`;
    if (known.length) ctx += `\nProjects pinned on this machine: ${sanitize(known.slice(0, 24).join(", "))}${known.length > 24 ? ", …" : ""}.\n`;
    // If the operator has DECLARED seats, recovery is one command — name it rather than making
    // them remember which directory each project lives in.
    try {
      const { readSeats } = await import("../lib/seats.mjs");
      const declared = Object.keys(readSeats());
      if (declared.length) {
        ctx += `\nDeclared seats on this machine: ${sanitize(declared.slice(0, 24).join(", "))}. `;
        ctx += `\`trantor seats\` shows which are missing and \`trantor seats up\` reopens each one in its own directory.\n`;
      }
    } catch {}
    ctx += `</trantor-not-a-seat>\n`;
    process.stderr.write(`[trantor] ${notSeat} — not registering on the bus (set RELAY_PROJECT to opt in)\n`);
    process.stdout.write(emit(ctx, banner, ""));
    process.exit(0);
  }
  const project = resolveProject(projectDir);
  sessionTitle = project;   // baseline — enriched with the current work item after the catch-up fetch below
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);
  // relayUrl() with no project resolves from the hook process's cwd, which is not always the
  // project the session is about. Pass it, or every call below can address the wrong hub.
  // resolveHubInfo carries HOW the hub was chosen so an unpinned project can be flagged below
  // instead of silently routing to the default.
  const { url, via: hubVia } = resolveHubInfo(project);

  // Self-enrol on an enforce hub BEFORE the first read/write, as crew-runner does for seats (#6270):
  // api.mjs's own ensureEnrolled POSTs /enroll with no invite, which a non-loopback enforce hub
  // refuses SILENTLY, and every read then 401s. lib/enroll.mjs mints a one-shot invite with the
  // OPERATOR's key. Never silent on failure: the reason lands in the banner and the model's context.
  const orchIdentity = loadIdentity(session);
  const enrolment = orchIdentity
    ? await ensureEnrolled(url, orchIdentity, project).catch((e) => ({ ok: false, reason: "error:" + String(e?.message || e).slice(0, 40) }))
    : { ok: false, reason: "no-identity" };
  if (!enrolment.ok && enrolment.reason !== "hub-unreachable") {
    const O = "\x1b[1;38;5;208m", R = "\x1b[0m";
    const line = `🟠 ${O}Not enrolled on ${url}${R} (${enrolment.reason}) — reads/writes may 401. `
      + `Fix: set an owner key (RELAY_OWNER_IDENTITY or ~/.agent-bus/config.json ownerIdentity) that can mint invites on this hub.`;
    userBanner = userBanner ? `${userBanner}\n${line}` : line;
    additionalContext += `<trantor-not-enrolled hub="${sanitize(url)}" reason="${sanitize(enrolment.reason)}">\n`;
    additionalContext += `⚠️ **This session's identity (\`${sanitize(session)}\`) is NOT enrolled on \`${sanitize(url)}\`** (reason: ${sanitize(enrolment.reason)}). `;
    additionalContext += `On an enforce hub this means board reads/writes will 401 until enrolment succeeds. This is not "the hub is down" — the hub is answering, it just does not recognize this identity yet. `;
    additionalContext += `Tell the user: the operator's owner key needs to be able to mint invites on this hub (RELAY_OWNER_IDENTITY env or \`ownerIdentity\` in ~/.agent-bus/config.json), then restart this session.\n`;
    additionalContext += `</trantor-not-enrolled>\n`;
    process.stderr.write(`[trantor] WARNING: ${session} not enrolled on ${url} (${enrolment.reason})\n`);
  }

  // register self + post an initial presence status (no LLM turn). kind "orch" when `trantor open`
  // badged THIS session as the orchestrator pane (#6075): the hub's own record of what a session
  // is, read by the overseer's declared-crew exemption. Strict match (badge === project); absent
  // kind is preserved by /register, so kindless heartbeats never erase this.
  const orchBadge = process.env.TRANTOR_ORCH || "";
  const registerBody = { session, project, status: `active in ${project}` };
  if (orchBadge === project) registerBody.kind = "orch";
  await jpost(`${url}/register`, registerBody, session).catch(() => {});

  // fetch roster of OTHER online sessions
  let peers = [], hubAnswered = false;
  try { peers = (await jget(`${url}/peers`, session)).peers || []; hubAnswered = true; } catch {}
  const others = peers.filter(p => p.online && p.session !== session);

  process.stderr.write(`[trantor] registered as ${session} -> ${url} (via ${hubVia}, ${others.length} other live session(s))\n`);

  // UNPINNED → the hub was a FALLBACK, not a decision. This session is on the bus, but possibly not
  // the bus its crew is on: pins route the known projects to the remote hub, and anything unpinned
  // drops to the global default. Two seats that believe they are the same project then read and
  // write different stores, each looking perfectly healthy. Never let that be silent.
  if (hubVia === "global" || hubVia === "default") {
    const known = knownProjects();
    const O = "\x1b[1;38;5;208m", R = "\x1b[0m";
    const line = `🟠 ${O}"${project}" is not pinned to a hub${R} — falling back to ${url}. `
      + `If the crew is on another hub this seat cannot see them. Pin it:  ${O}trantor hub set ${project} <url>${R}`;
    userBanner = userBanner ? `${userBanner}\n${line}` : line;
    additionalContext += `<trantor-hub-unpinned project="${sanitize(project)}" hub="${sanitize(url)}" via="${sanitize(hubVia)}">\n`;
    additionalContext += `⚠️ **The project "${sanitize(project)}" has no hub pin.** This seat fell back to \`${sanitize(url)}\` (${hubVia === "global" ? "the global default" : "the built-in local default"}), which is a guess, not a routing decision.\n`;
    additionalContext += `If the rest of the crew is pinned to a different hub, you will see an empty board and no peers while every hub is healthy — do NOT diagnose that as "Trantor is down". Confirm with \`trantor hub list\`, and pin this project with \`trantor hub set ${sanitize(project)} <url>\` so the routing is deliberate.\n`;
    if (known.length) additionalContext += `\nPinned projects: ${sanitize(known.slice(0, 24).join(", "))}${known.length > 24 ? ", …" : ""}.\n`;
    additionalContext += `</trantor-hub-unpinned>\n`;
    process.stderr.write(`[trantor] WARNING: project "${project}" is unpinned; hub ${url} chosen via ${hubVia}\n`);
  }

  if (others.length > 0) {
    additionalContext += `<trantor session="${session}" hub="${url}">\n`;
    additionalContext += `You are connected to Trantor (the cross-agent session bus) as "${session}". Other LIVE agent sessions are running right now:\n`;
    for (const p of others) additionalContext += `- ${sanitize(p.session)}\n`;
    additionalContext += `Use the relay MCP tools (relay_peers, relay_send, relay_inbox, relay_wait) to coordinate with them — hand off work, check for overlap before editing shared files, or ask another session for help. If a sibling session is touching the same project, coordinate before making conflicting changes.\n`;
    additionalContext += `</trantor>\n`;
  }

  // ── GRANTS: standing permissions the operator has APPROVED for this project ──────
  // An approval used to live only in a one-shot DM that died with its session; injecting active
  // grants here means every future seat inherits the operator's recorded decisions.
  try {
    const { grants = [] } = await jget(`${url}/grants?project=${encodeURIComponent(project)}`, session);
    if (grants.length) {
      additionalContext += `<trantor-grants project="${sanitize(project)}">\n`;
      additionalContext += `Standing permissions the operator has APPROVED (act within the stated bound without re-asking; everything outside it still needs a proposal):\n`;
      for (const g of grants.slice(-10)) additionalContext += `- [#${g.id}${g.key ? ` ${sanitize(g.key)}` : ""}] ${sanitize(g.scope)} — WHEN: ${sanitize(g.condition)} — NOT covered: ${sanitize(g.exclusions)}\n`;
      additionalContext += `</trantor-grants>\n`;
    }
  } catch {}

  // ── ADOPT live crews (intersession-ops S1+S2, contract #4215) ─────────────────
  // Every boot inventories leftover crew resources (#4214) and steers toward ADOPTING a live crew
  // rather than `trantor up`-ing over it. Detection is sync + fail-silent; dead-row cleanup runs
  // detached and unref'd. The lib import is OPTIONAL so a missing lib is a no-op, never a boot error.
  let res = null;
  try { res = await import("./lib/resources.mjs"); } catch {}
  if (res) {
    try {
      const __t0 = process.hrtime.bigint();
      const __elapsedMs = () => Number(process.hrtime.bigint() - __t0) / 1e6;
      // resources.mjs is optional and versioned separately: take its exports once, with no-op defaults
      const { liveRunners = () => [], listCrewRows = () => [], devServers = () => [] } = res;
      const runners  = safeInv(() => liveRunners(project), []);
      const rows     = safeInv(() => listCrewRows(), []);
      const projRows = (Array.isArray(rows) ? rows : []).filter(r => r && r.project === project);
      // Only touch the (relatively) costly devServers/lsof when we're actually emitting a block.
      if ((Array.isArray(runners) && runners.length > 0) || projRows.length > 0) {
        // devServers is "report only" and (per kimi's #4214 impl) costs ~180ms via per-match lsof.
        // Include it only while the <300ms hard latency budget still has room; otherwise defer to the
        // duty patrol (#4216), which inventories dev servers machine-wide. A solo session (no crew →
        // liveRunners ~50ms) always gets the dev-server line; a live multi-seat crew usually defers.
        let devSrv = [];
        if (__elapsedMs() < 120) devSrv = safeInv(() => devServers(projectDir), []);
        else process.stderr.write(`[trantor] devServers deferred to patrol (${__elapsedMs().toFixed(0)}ms elapsed, <300ms budget)\n`);
        const seats = (Array.isArray(runners) ? runners : [])
          .map(r => `${sanitize(r.agent || "?")}(${r.pid || "?"})`).filter(Boolean).join(", ");
        const devs = (Array.isArray(devSrv) ? devSrv : [])
          .map(d => `${sanitize(String(d.cmd || "dev").trim().split(/\s+/)[0] || "dev")}(${d.pid || "?"})`).join(", ");
        const adopt = [];
        if (Array.isArray(runners) && runners.length > 0) {
          adopt.push(`A LIVE crew for "${sanitize(project)}" is already running (seats: ${seats}).`);
          adopt.push(`ADOPT it: read \`relay_board\`, announce yourself to the seats over the bus, and continue their in-flight work.`);
          adopt.push(`Do NOT run \`trantor up\` over healthy seats — replace-in-place kills their context.`);
          if (devs) adopt.push(`Dev servers already up: ${devs} (report only — leave them running).`);
          adopt.push(`Provably-dead tracking rows are being cleaned up in the background.`);
        } else {
          adopt.push(`No live crew for "${sanitize(project)}", but ${projRows.length} stale tracking row(s) exist from a prior session.`);
          adopt.push(`Background cleanup is verifying them and dropping only the provably-dead (no live process AND no heartbeat AND no owning session).`);
          if (devs) adopt.push(`Dev servers up: ${devs} (report only).`);
        }
        additionalContext += `<trantor-resources>\n${adopt.join("\n")}\n</trantor-resources>\n`;
        process.stderr.write(`[trantor] crew inventory: ${runners.length} live, ${projRows.length} stale row(s) for ${project}\n`);
      }
    } catch {}
    // Fire-and-forget dead-row cleanup — detached + unref'd + stdio ignored, NEVER awaited. We call
    // cleanDead(project) by name through the #4214 lib; a missing/half-landed lib → child exits
    // silently. This is the ONLY mutation and it drops dead tracking rows, nothing live.
    try {
      const modPath = join(dirname(fileURLToPath(import.meta.url)), "lib", "resources.mjs");
      const kid = spawn(process.execPath, ["--input-type=module", "-e",
        `import(${JSON.stringify(modPath)}).then(m=>{try{if(typeof m.cleanDead==="function")m.cleanDead(${JSON.stringify(project)})}catch{}}).catch(()=>{})`
      ], { detached: true, stdio: "ignore", env: { ...process.env, RELAY_PROJECT: project } });
      kid.unref();
    } catch {}
  }

  // CATCH-UP: a project is a DURABLE, continuous lane — not a session. Before doing
  // anything, this session reconciles with the living board: what's been built, what's
  // in flight, what's queued, plus the latest commits. So a fresh window resumes the
  // SAME project where it stands instead of starting blind. Cheap + LLM-free.
  try {
    const cu = await jget(`${url}/catchup?project=${encodeURIComponent(project)}`, session).catch(() => null);
    sessionTitle = sessionTitleFrom(project, cu);   // "<project> · <current work>" for the picker/--resume/mobile
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
        // Intelligent-cleanup nudge: if the board has a pile of in-flight/stale cards, some are probably
        // already shipped (a stuck card ≠ unfinished work). Point the session at `trantor reconcile`, which
        // judges each stuck card against git + memory (cheap model) and closes what's done — so no session
        // burns tokens re-doing finished work — and stales what's truly abandoned.
        const stuck = (c.doing || 0) + (c.testing || 0) + (c.stale || 0);
        if (stuck >= 4 || (c.stale || 0) > 0) additionalContext += `\n🧠 **${stuck} card(s) look stuck** (doing/testing/stale). Some may already be shipped. Run \`trantor reconcile\` — it checks git + memory (cheap model), closes anything already done so you don't re-do it, and stales what's abandoned. Preview first; \`--yes\` applies.\n`;
      }
      if (gitlog) additionalContext += `\n**Recent commits:**\n\`\`\`\n${sanitize(gitlog)}\n\`\`\`\n`;
      additionalContext += `\nFor a synthesized "where are we" narrative on demand, run \`trantor catchup\`.\n`;
      additionalContext += `</trantor-project-state>\n`;
      process.stderr.write(`[trantor] injected project-state catch-up for ${project} (${cu?.total || 0} cards)\n`);
    }
  } catch {}

  // THE ORCHESTRATOR ROLE: a session opened by `trantor open` carries TRANTOR_ORCH=<project> and
  // gets the doctrine at boot, so the role survives wakes, handoffs and restarts. #6226: it also
  // carries the dispatch rule (confirm the target from badge + cwd; never wake a session that is
  // asking the operator a question).
  try {
    if (project && (process.env.TRANTOR_ORCH || "") === project) {
      additionalContext += `<trantor-orchestrator-role project="${sanitize(project)}">\n` +
        `🎛️ **You are this project's ORCHESTRATOR — a project manager, not a coder** (operator ruling, 2026-08-31).\n` +
        `- Building goes to the CREW: invoke the trantor:crew skill (Advisor → \`trantor up\` seats → contracts over the bus), or relay_scrooge for grunt one-shots.\n` +
        `- Spend your own tokens on design, contracts, supervision, integration and VERIFICATION — run the seats' tests yourself; bounce hollow dones.\n` +
        `- Write code yourself ONLY for small one-head seam work that needs this session's full context — and say so when you do.\n` +
        `- Check relay_inbox and the board before asking the operator anything a peer may already have answered.\n` +
        `- Dispatch rule: the target project is confirmed from the session's badge and cwd before any relay_send, relay_task_add or \`trantor up\` — an ambiguous instruction is not a project name; and a session asking the operator a question never triggers a wake (its messages batch until the answer).\n` +
        `</trantor-orchestrator-role>\n`;
      process.stderr.write(`[trantor] injected orchestrator-role doctrine for ${project}\n`);
    }
  } catch {}

  // Update available? An in-terminal `systemMessage` the USER sees at session start (a macOS popup
  // is misattributed to Script Editor and fires off-screen), persistent until they update, plus the
  // <trantor-update> context block for the model. Desktop notification is OPT-IN
  // (config.updateDesktopNotify:true). Throttled (6h TTL), fail-silent; TRANTOR_NO_UPDATE_CHECK disables.
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

  // Inbox ledger: stamp session start and seed the cursor NOW, the moment that defines "backlog"
  // (seeding on the first successful poll once swallowed everything before it). Compaction keeps
  // the session_id, so an existing ledger is left alone. Written before any network I/O.
  if (stdinObj.session_id && source !== "compact") {
    try {
      const paths = ledgerPaths(session, String(stdinObj.session_id));
      const startTs = ensureStart(paths);   // the stamp costs nothing and must land even when the hub is down
      if (hubAnswered && !existsSync(paths.cursorFile)) {
        const seed = await signedGet(`/inbox?session=${encodeURIComponent(session)}&since=0&peek=1`, { timeoutMs: 3000, session, instance: String(stdinObj.session_id), project });
        if (seed.ok) {
          const cursor = anchorCursor(seed.json?.messages, startTs);
          writeCursor(paths, cursor);
          // claim the pre-start backlog on the hub too, so it never escalates as undelivered
          await signedGet(`/inbox?session=${encodeURIComponent(session)}&since=${Math.max(0, cursor - 1)}`, { timeoutMs: 1500, session, instance: String(stdinObj.session_id), project }).catch(() => {});
        }
      }
    } catch {}
  }

  // Pending handoff? Take over with this fresh window instead of starting cold. A compact start
  // shows it for continuity but never claims (it is the writer). A handoff written by the recorded
  // orchestrator thread is HELD for the orchestrator pane (TRANTOR_ORCH) for a window (default 30m,
  // then it lapses); any other handoff keeps first-fresh-session-wins.
  const isCompact = source === "compact";
  // A RESUMED session must never claim a handoff: it already carries its whole history, so the
  // recap would look right while the window never reset. The successor is a fresh session.
  const isResume = source === "resume";
  const orchEnv = process.env.TRANTOR_ORCH || "";
  const isOrchPane = !!orchEnv && (orchEnv === "1" || orchEnv === project);   // project-matched: a child claude in another dir must not inherit the badge
  const orchSid = readOrchSession(project);
  const holdMs = Number(process.env.TRANTOR_ORCH_HOLD_MS || 30 * 60 * 1000);
  const peek = loadPendingHandoff(basename(projectDir), { claim: false });
  const orchOrigin = !!(peek && orchSid && peek.session_id && peek.session_id === orchSid);
  const ageMs = peek ? Date.now() - (Number(peek.stamp) || 0) * 1000 : 0;
  const held = orchOrigin && !isOrchPane && !isCompact && ageMs < holdMs;
  const handoff = !peek ? null
    : (isCompact || held || isResume) ? peek
    : loadPendingHandoff(basename(projectDir), {
        claim: true,
        freshSession: { session_id: stdinObj.session_id || "", transcript_path: stdinObj.transcript_path || "" },
      });
  const claimed = !!handoff && !isCompact && !held && !isResume;
  // Follow the thread: claiming the orchestrator's baton makes THIS session the orchestrator
  // thread, so the map `trantor open` resumes and the app's chat reads moves with it. The pane
  // also records itself on every fresh start — that keeps the map honest even if a future
  // claude forks the session id on resume.
  if (claimed && orchOrigin && stdinObj.session_id) writeOrchSession(project, String(stdinObj.session_id), "sessionstart-claim");
  if (isOrchPane && !isCompact && stdinObj.session_id) writeOrchSession(project, String(stdinObj.session_id), "orch-pane-start");
  if (handoff && held) {
    process.stderr.write(`[trantor] pending handoff ${handoff.id} HELD for the orch pane (${Math.round(ageMs / 60000)}m old)\n`);
    const mins = Math.max(1, Math.round((holdMs - ageMs) / 60000));
    additionalContext += `<trantor-handoff-held id="${sanitize(handoff.id)}" from="${sanitize(handoff.machine)}">\n`;
    additionalContext += `🔒 A handoff from this project's ORCHESTRATOR thread is pending, and it is being HELD for the Trantor orchestrator pane (\`trantor open\` claims it on start). This session did NOT claim it and does not have its content — do not act as the successor. If the user wants THIS session to take over instead: \`trantor adopt\`, then restart this session. Unclaimed, the hold lapses in ~${mins} minute(s) and the handoff becomes first-come.\n`;
    additionalContext += `</trantor-handoff-held>\n`;
  } else if (handoff && isResume) {
    // No takeover banner here — injecting it into a resumed session is exactly the failure this
    // guard exists for: the recap reads like a clean handoff while the context never reset.
    process.stderr.write(`[trantor] pending handoff ${handoff.id} NOT claimed — this session was RESUMED, not started fresh\n`);
    additionalContext += `<trantor-handoff-unclaimed id="${sanitize(handoff.id)}" reason="resumed-session">\n`;
    additionalContext += `⚠️ An unclaimed handoff (${sanitize(handoff.id)}) is waiting for this project, but THIS session was RESUMED (\`--resume\`) — it already carries its own history and is NOT the successor. Do not act on the handoff. Tell the user plainly: a fresh session must claim it — \`trantor open\` starts one. If they want THIS resumed session to continue instead, they can ignore the handoff or clear it.\n`;
    additionalContext += `</trantor-handoff-unclaimed>\n`;
  } else if (handoff) {
    process.stderr.write(`[trantor] ${isCompact ? "showing (not claiming, compact)" : "loaded"} pending handoff ${handoff.id}\n`);
    // Baton claimed → supersede every OTHER instance of this durable identity (instance-keys
    // contract). The dying twin's next /inbox or /poll answer tells its model to stand down —
    // the hub-enforced end of the twin message race. Best-effort; compact shows don't claim.
    if (claimed && stdinObj.session_id) {
      await jpost(`${url}/instance/supersede`, { name: session, exceptInstanceId: String(stdinObj.session_id) }, session).catch(() => {});
    }
    additionalContext += `<trantor-handoff id="${sanitize(handoff.id)}" from="${sanitize(handoff.machine)}" trigger="${sanitize(handoff.trigger)}" mode="${sanitize(handoff.mode === "unattended" ? "unattended" : "attended")}">\n`;
    // #5645 mandate pinning: the successor's orders ride rec.mode (#5644's long-run switch flips it).
    // attended (default) = recap-then-WAIT; unattended = recap-then-RESUME — the handoff's OPEN
    // THREADS are the work order ("handoffs must never be a break").
    if (handoff.mode === "unattended") {
      additionalContext += `🔄 **You are taking over from a prior session that hit its context limit, in UNATTENDED (long-run) mode.** This is a fresh full window. Resume the work below — the prior session's summary, git state, and a pointer to its full transcript (searchable; Foundation/Gaia has it ingested) follow. Continue from "OPEN THREADS & NEXT STEPS"; do not restart from scratch. Recap the task, state, and next step in at most 3 sentences, then RESUME the open threads immediately — they are your work order. Do NOT wait for the user; keep building. Keep replies short: no status tables, no headers, no walls of text.\n\n`;
    } else {
      additionalContext += `🔄 **You are taking over from a prior session that hit its context limit.** This is a fresh full window. Resume the work below — the prior session's summary, git state, and a pointer to its full transcript (searchable; Foundation/Gaia has it ingested) follow. Continue from "OPEN THREADS & NEXT STEPS"; do not restart from scratch. Recap the task, state, and next step in at most 3 sentences, then wait. Keep replies short: no status tables, no headers, no walls of text unless the user explicitly asks for detail.\n\n`;
    }
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
    // The structured working state (TDD §4.5), AFTER the recap instruction and above the prose: it
    // is bounded by the schema's own caps, so unlike the summary it cannot have lost a member to an
    // elision (#6528). A record without one — every handoff until the flag is on — renders nothing
    // and the successor sees exactly today's prose handoff.
    const stateBlock = renderStateBlock(handoff.state);
    if (stateBlock) {
      additionalContext += `## Working state (structured, card #${sanitize(String(handoff.state.card || 0))}, turn ${sanitize(String(handoff.state.cursor?.turn ?? 0))})\n`;
      additionalContext += `${sanitize(stateBlock)}\n\n`;
    }
    additionalContext += `## Handoff summary\n${sanitize(capHandoffSummary(handoff))}\n`;
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
function emit(ctx, sysMsg, title) {
  const obj = {};
  if (ctx) obj.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: ctx };
  if (title) (obj.hookSpecificOutput ||= { hookEventName: "SessionStart" }).sessionTitle = title;
  if (sysMsg) obj.systemMessage = sysMsg;
  const out = JSON.stringify(obj);
  try { JSON.parse(out); return out; } catch { /* fall through */ }
  try {
    const safe = {};
    if (ctx) safe.hookSpecificOutput = { hookEventName: "SessionStart", additionalContext: sanitize(ctx) };
    if (title) (safe.hookSpecificOutput ||= { hookEventName: "SessionStart" }).sessionTitle = sanitize(title);
    if (sysMsg) safe.systemMessage = sanitize(sysMsg);
    return JSON.stringify(safe);
  } catch { return "{}"; }
}
// Set the session title unless the user already named it explicitly (--name / rename).
process.stdout.write(emit(additionalContext, userBanner, userTitle ? "" : sessionTitle));
process.exit(0);
