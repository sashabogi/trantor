#!/usr/bin/env node
// trantor PostToolUse inbox delivery — delivery is pull-on-demand and a busy session never polls, so
// this hook polls /inbox on each tool call and injects NEW peer messages as additionalContext.
// Cheap + fail-silent by contract: poll stamp, short timeout, always valid stdout. The cursor anchors
// to SESSION START (hooks/lib/inbox-ledger.mjs), never to the first successful poll.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProject, hostId, busDir } from "../lib/project.mjs";
import { signedGet } from "./lib/api.mjs";   // signed: enforce hubs 401 unsigned reads — unsigned, T1 delivery is silently dead
import { ledgerPaths, ensureStart, anchorCursor, writeCursor } from "./lib/inbox-ledger.mjs";

const POLL_MS = Number(process.env.RELAY_INBOX_POLL_MS || 4000);
const FETCH_TIMEOUT_MS = Number(process.env.RELAY_INBOX_TIMEOUT_MS || 1500);
// The first poll of a session also enrolls its instance key on the hub (up to 4s on a remote hub);
// 1.5s guaranteed it timed out and the seed slid to a later, random tool call. Paid once per session.
const FIRST_RUN_TIMEOUT_MS = Number(process.env.RELAY_INBOX_FIRST_TIMEOUT_MS || 4000);

// Keep injected text safe to embed in JSON: drop control chars that could corrupt the
// additionalContext payload (the model still gets the readable message).
function sanitize(s) { return String(s == null ? "" : s).replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }

async function getInbox(session, since, instance, project, { peek = false, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const { ok, json } = await signedGet(`/inbox?session=${encodeURIComponent(session)}&since=${since}${peek ? "&peek=1" : ""}`, { timeoutMs, session, instance, project });
  if (!ok || !json) throw new Error("hub unreachable");
  return json;   // { messages: [...], cursor, superseded? }
}

// PostToolUse hands the tool-input JSON on stdin and it MUST be drained (a big Write can exceed the
// pipe buffer) and KEPT: session_id keys the per-instance cursor and cwd names the project.
function drainStdin() {
  return new Promise(res => {
    let d = "";
    try {
      process.stdin.setEncoding("utf8"); process.stdin.resume();
      process.stdin.on("data", c => (d += c));
      process.stdin.on("end", () => res(d));
    } catch { res(d); }
    setTimeout(() => res(d), 80);
  });
}

// Self-validating stdout: model-facing additionalContext only when we actually deliver.
function emit(ctx) {
  if (!ctx) return "{}";
  const obj = { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } };
  const out = JSON.stringify(obj);
  try { JSON.parse(out); return out; } catch { return "{}"; }
}

async function main(stdinRaw) {
  // The harness session_id is this session's INSTANCE id (docs/INSTANCE-KEYS-CONTRACT.md): it keys
  // the endorsed subkey that signs our reads AND the local cursor, so a baton twin (same durable
  // name, different session_id) has its own ledger and can't eat this session's messages.
  let instanceId = "";
  try { instanceId = String(JSON.parse(stdinRaw || "{}").session_id || ""); } catch {}
  // input.cwd FIRST — every hook must derive the project the SAME way, or two hooks in one
  // session resolve two projects, two hubs, and half the work records where nobody reads.
  let _in = {}; try { _in = JSON.parse(stdinRaw || "{}"); } catch {}
  const projectDir = _in.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Mirror heartbeat.mjs / sessionstart.mjs: a home-directory session isn't project work and
  // isn't on the bus — nothing to deliver. Opt in with RELAY_SESSION / RELAY_PROJECT.
  if (!process.env.RELAY_SESSION && !process.env.RELAY_PROJECT && projectDir === homedir()) return "{}";

  // Resolve THIS session's identity EXACTLY as mcp.mjs / heartbeat.mjs do, so we poll the
  // same peer the relay registered (RELAY_SESSION wins; else RELAY_AGENT brand; else host:project).
  const project = resolveProject(projectDir);

  // IDENTITY DRIFT: the relay MCP resolved its project once at session start and cannot see a later
  // `cd`, while hooks resolve per call. Not repairable here, so say it plainly, once, with the ways out.
  const driftNote = (() => {
    try {
      const startDir = process.env.CLAUDE_PROJECT_DIR || "";
      if (!startDir || startDir === projectDir) return "";
      const startProject = resolveProject(startDir);
      if (!startProject || startProject === project) return "";
      const session0 = String(_in.session_id || "s");
      const seat = (p) => (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${p}` : `${hostId()}:${p}`);
      const marker = join(busDir(), `inbox-drift-${[session0, startProject, project].join("-")}`.replace(/[^A-Za-z0-9_.@-]/g, "_"));
      if (existsSync(marker)) return "";
      try { writeFileSync(marker, String(Date.now())); } catch {}
      return `<trantor-identity-drift receiving="${seat(project)}" sending="${seat(startProject)}">\n`
        + `⚠️ **This session now has two bus identities.** You are working in \`${projectDir}\` but the session `
        + `started in \`${startDir}\`, and the relay MCP server is a separate process that resolved its project `
        + `once at boot and cannot follow a directory change.\n`
        + `- Mail reaches you as **${seat(project)}** (this directory).\n`
        + `- \`relay_send\`, \`relay_task_add\` and the other relay tools speak as **${seat(startProject)}** (where the session began).\n`
        + `So reads can work while sends fail: on a hub running RELAY_AUTH=enforce the sending identity may not be `
        + `enrolled, and relay_send returns 401 while messages keep arriving.\n`
        + `**Two ways out:** start the session from the project directory (\`cd ${projectDir} && claude\`), or set `
        + `\`RELAY_PROJECT=${project}\` for the session so both halves resolve the same way. Until then, say so rather `
        + `than reporting the bus as broken.\n</trantor-identity-drift>\n`;
    } catch { return ""; }
  })();

  // Surface it on its own call. The paths below bail early on a poll throttle, an empty inbox or a
  // down hub, so folding the notice in there would mean it almost never appears.
  if (driftNote) return emit(driftNote);
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);

  const paths = ledgerPaths(session, instanceId);
  const { pollStamp, cursorFile } = paths;
  // Session start, as this ledger knows it: stamped before any network call so a failed first poll
  // can't move it. Written on the first run of the session (sessionstart.mjs usually got there first).
  const startTs = ensureStart(paths);

  // Throttle: poll the hub at most once per POLL_MS. Write the stamp BEFORE the network call
  // so a burst of parallel tool calls doesn't all fire (and double-deliver).
  try {
    if (existsSync(pollStamp)) {
      const last = Number(readFileSync(pollStamp, "utf8")) || 0;
      if (Date.now() - last < POLL_MS) return "{}";   // within window — skip
    }
  } catch {}
  try { writeFileSync(pollStamp, String(Date.now())); } catch {}

  let cursor = 0;
  if (!existsSync(cursorFile)) {
    // First successful run: PEEK the whole inbox and anchor to session start. Backlog from before the
    // session is skipped (and claimed below, so the hub's ledger agrees); anything newer falls through
    // to the normal path and is delivered right now. On failure write nothing — the start stamp keeps
    // the anchor honest for the next attempt.
    try {
      const res = await getInbox(session, 0, instanceId, project, { peek: true, timeoutMs: FIRST_RUN_TIMEOUT_MS });
      cursor = anchorCursor(res.messages, startTs);
      writeCursor(paths, cursor);
    } catch { return "{}"; }
  } else {
    try { cursor = Number(readFileSync(cursorFile, "utf8")) || 0; } catch {}
  }

  let messages = [], next = cursor, superseded = false;
  try {
    const res = await getInbox(session, cursor, instanceId, project);
    messages = Array.isArray(res.messages) ? res.messages : [];
    next = res.cursor || cursor;
    superseded = res.superseded === true;
  } catch { return "{}"; }   // hub down / timeout — never block the tool flow

  // Stand-down note (never a block): a newer instance of this durable identity claimed the baton.
  if (superseded && !messages.length) {
    return emit(`<trantor-inbox count="0">\n⚠️ A newer instance of this session has claimed the baton (instance supersession). Stand down: finish your current thought, do not consume bus messages, and let the new session carry the work.\n</trantor-inbox>\n`);
  }

  if (!messages.length) return "{}";

  // Advance the cursor immediately so we don't re-inject these on the next tool call.
  try { writeFileSync(cursorFile, String(next)); } catch {}

  const lines = messages.map(m => {
    const direct = m.to === session;
    const tag = direct ? "📨 DIRECT" : "📣 broadcast";
    const when = (() => { try { return new Date(m.ts).toLocaleTimeString(); } catch { return ""; } })();
    return `- ${tag} from ${sanitize(m.from)}${when ? ` (${when})` : ""}: ${sanitize(m.text)}`;
  });

  const ctx =
    `<trantor-inbox count="${messages.length}">\n` +
    (superseded ? `⚠️ A newer instance of this session has claimed the baton — stand down after handling anything addressed directly to you; the new session carries the work.\n` : "") +
    `📬 ${messages.length} new bus message(s) arrived while you were working (you did not poll for these — Trantor surfaced them automatically):\n` +
    lines.join("\n") + `\n` +
    `If a peer is asking you something or waiting on you, reply now with the relay_send tool (to their session id). ` +
    `If a message just needs an ack, send a short one. You can keep working after responding.\n` +
    `</trantor-inbox>\n`;

  return emit(ctx);
}

// Never block or break the tool flow: drain stdin, swallow everything, always emit valid stdout.
drainStdin()
  .then(main)
  .then(out => { try { process.stdout.write(out || "{}"); } catch {} })
  .catch(() => { try { process.stdout.write("{}"); } catch {} })
  .finally(() => process.exit(0));
