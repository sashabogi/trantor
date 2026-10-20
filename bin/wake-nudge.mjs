#!/usr/bin/env node
// #7429: hub detection → local socket wake; the duty model handles unreachable recipients.
// up/down/status manage com.trantor.wake-nudge; run/once poll with the existing duty identity.
// --hub overrides fleet config; AGENT_BUS_DIR controls ledger, cursor and log paths.
// Latency: hub UNDELIVERED after 2m → 5s incremental event poll → socket → inbox hook.

// #7429: read hub:duty events without consuming duty's inbox; ignore delivered/24h-old alerts.
// Resolve this host's idle Claude via herdr, the session map and an unambiguous process tree.
// Authenticate with its token, send ID-only NDJSON, and never inject terminal input or log tokens.
// Record only after its poll stamp advances within 10s; a poll proves activity, not a reply.

// #7429: duty-nudged.json claims are the ONLY arbitration with duty: first claim wins.
// The audit releases unverified claims; verified records deduplicate daemon restarts.
// Busy, remote and unresolved sessions fall through; no priority or takeover is implied.
// KeepAlive + RunAtLoad use a 30s crash throttle; installation never enrolls a new identity.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { load } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";
import { busDir, hostId, readConfig } from "../lib/project.mjs";
import { ledgerPaths } from "../hooks/lib/inbox-ledger.mjs";
import { dutyEscalations, claimDutyNudges, auditDutyNudges, releaseDutyNudgeClaims } from "../lib/duty-nudges.mjs";
import { reserveNudgeIds, releaseNudgeIds } from "../lib/nudge-ledger.mjs";
import { recipientPanes } from "../lib/duty-recipient.mjs";

const SELF = fileURLToPath(import.meta.url);
const LABEL = "com.trantor.wake-nudge";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = path => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
const claudeProcess = command => /^(?:\S*\/)?claude(?:\.exe)?(?:\s|$)/.test(command);

export function processRows(text) {
  return text.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function descendants(pid, rows) {
  const found = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (found.has(row.ppid) && !found.has(row.pid) && !claudeProcess(row.command)) {
        found.add(row.pid); changed = true;
      }
    }
  }
  return [...found];
}

export function tokenFromEnvironment(text, socketPath) {
  const socket = /(?:^|\s)CLAUDE_CODE_MESSAGING_SOCKET=(\S+)/.exec(text)?.[1];
  if (socket !== socketPath) return "";
  return /(?:^|\s)CLAUDE_CODE_MESSAGING_TOKEN=(\S+)/.exec(text)?.[1] || "";
}

// #12092: CC 2.1.248 may bind under a private per-user directory instead of the default one, so the
// socket path comes from the target's own CLAUDE_CODE_MESSAGING_SOCKET. This is the same text read as above.
export function messagingFromEnvironment(text) {
  const socket = /(?:^|\s)CLAUDE_CODE_MESSAGING_SOCKET=(\S+)/.exec(text)?.[1] || "";
  const token = /(?:^|\s)CLAUDE_CODE_MESSAGING_TOKEN=(\S+)/.exec(text)?.[1] || "";
  return { socket: socket.startsWith("/") && !socket.split("/").includes("..") ? socket : "", token };
}

// #12092: where CC binds when the env var cannot be trusted (read from the CC 2.1.304 binary): the
// default <XDG_RUNTIME_DIR or tmp>/cc-socks, and the per-uid fallback <tmp>/cc-socks-<uid> used when
// the default is refused or the path is over 103 bytes. macOS /tmp is /private/tmp, so both spellings.
export function fallbackSocketDirs({ env = process.env, uid = process.getuid?.() ?? 0 } = {}) {
  const dirs = [];
  if (env.XDG_RUNTIME_DIR) dirs.push(join(env.XDG_RUNTIME_DIR, "cc-socks"));
  for (const base of ["/tmp", "/private/tmp"]) dirs.push(join(base, "cc-socks"), join(base, `cc-socks-${uid}`));
  return [...new Set(dirs)];
}

// #12092: a structured verdict so an unreachable session carries a reason; resolveRecipient keeps
// the old null-or-target contract. `quiet` marks ordinary skips (remote, busy, ambiguous) from
// reportable ones (the session is local and idle but has no usable socket).
export function resolveRecipientDetailed(recipient, { bus = busDir(), localHost = hostId(), command = run, socketDir } = {}) {
  const skip = reason => ({ ok: false, quiet: true, reason });
  const unreachable = reason => ({ ok: false, quiet: false, reason });
  if (!recipient.startsWith(`${localHost}:`)) return skip("not a local recipient");
  const project = recipient.slice(localHost.length + 1);
  const mapped = read(join(bus, "orch-sessions.txt")).split("\n").find(line => line.split("\t")[0] === project)?.split("\t")[1]?.trim();
  let agents = [];
  try { agents = JSON.parse(command("herdr", ["agent", "list"])).result.agents; } catch { /* #7429: map remains available without herdr. */ }
  const panes = recipientPanes(project, mapped, agents);
  if (panes.length > 1) return skip("more than one candidate pane");
  const pane = panes[0];
  if (["working", "busy"].includes(pane?.agent_status)) return skip("busy");
  const sid = pane?.agent_session?.value || mapped;
  if (!sid || !/^[\w-]+$/.test(sid)) return skip("no session id");
  const rows = processRows(command("ps", ["-axo", "pid=,ppid=,command="]));
  let matches = rows.filter(row => claudeProcess(row.command) && new RegExp(`(?:--session-id|--resume|-r)\\s+${sid}(?:\\s|$)`).test(row.command));
  if (!matches.length && pane) {
    try {
      const info = JSON.parse(command("herdr", ["pane", "process-info", "--pane", pane.pane_id])).result.process_info;
      const pids = new Set(info.foreground_processes.filter(p => /^(claude|claude.exe)$/.test(p.name)).map(p => p.pid));
      matches = rows.filter(row => pids.has(row.pid) && claudeProcess(row.command));
    } catch { return skip("claude process not found via herdr"); }
  }
  if (matches.length !== 1) return skip(matches.length ? "more than one claude process" : "claude process not found");
  const pid = matches[0].pid;
  // #7429: preserve ps's default columns for env. Only the target's own process tree is read.
  let socket = ""; let token = "";
  for (const envPid of descendants(pid, rows)) {
    let found;
    try { found = messagingFromEnvironment(command("ps", ["eww", "-p", String(envPid)])); } catch { continue; }
    if (found.token && (found.socket || !socket)) { ({ socket, token } = found); if (socket) break; }
  }
  // #12092: CC 2.1.290 --restricted sessions (and any session with messaging off) never open a socket.
  if (!token) return unreachable(`no CLAUDE_CODE_MESSAGING_TOKEN in claude pid ${pid}'s environment (--restricted or cross-session messaging off); no socket to nudge`);
  const dirs = socketDir ? [].concat(socketDir) : fallbackSocketDirs();
  const tried = [socket, ...dirs.map(dir => join(dir, `${pid}.sock`))].filter(Boolean);
  const socketPath = tried.find(path => existsSync(path));
  if (!socketPath) return unreachable(`claude pid ${pid} has a messaging token but no socket exists at ${tried.join(" or ")}`);
  return { ok: true, target: { pid, sid, token, socketPath, pollStamp: ledgerPaths(recipient, sid, bus).pollStamp } };
}

export function resolveRecipient(recipient, options = {}) {
  const verdict = resolveRecipientDetailed(recipient, options);
  return verdict.ok ? verdict.target : null;
}

// #12092: the inbox drops a silent connection after 30s, so write both newline-ended lines at once,
// half-close and time out fast. It never replies here (held/refused go to the sender's own inbox).
export function postNudgeDetailed({ socketPath, token, sid }, ids, timeoutMs = 1500) {
  const content = `<cross-session-message from="trantor:wake">\nYour Trantor bus inbox has unread message ids ${ids.map(id => `#${id}`).join(", ")}. Read them with relay_inbox and reply over the bus with relay_send. This nudge carries no message content; the signed bus messages are the source of truth.\n</cross-session-message>`;
  const lines = [{ type: "auth", token }, { type: "user", session_id: sid, message: { role: "user", content } }];
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    let sent = false; let settled = false; let failure = "";
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true; clearTimeout(hard); socket.destroy(); resolve({ ok, reason });
    };
    const hard = setTimeout(() => finish(false, sent ? "no close from the inbox after the write" : "connect or write timed out"), timeoutMs);
    hard.unref();
    socket.on("error", error => { failure = error.code || error.message; finish(false, `socket error ${failure}`); });
    socket.on("connect", () => socket.end(lines.map(line => JSON.stringify(line)).join("\n") + "\n", () => { sent = true; }));
    socket.on("close", hadError => finish(sent && !hadError, sent ? "" : "closed before the write finished"));
  });
}

export async function postNudge(target, ids, timeoutMs) {
  return (await postNudgeDetailed(target, ids, timeoutMs)).ok;
}

export async function wakeOnce({ api, bus = busDir(), resolver = recipient => { const verdict = resolveRecipientDetailed(recipient, { bus }); return verdict.ok ? verdict.target : verdict.quiet ? null : { unreachable: verdict.reason }; }, verifyMs = 10000, now = Date.now(), attempted = new Set(), cursor = { id: 0, ts: 0 }, log = m => console.error(m) }) {
  const feed = await api(`/events?type=message&by=hub%3Aduty&since=${cursor.id}${cursor.id ? "" : "&limit=2000"}`);
  if (Number.isFinite(feed.latest) && feed.latest < cursor.id) {
    cursor.id = 0; cursor.ts = 0;
    return { nudged: [], missing: [] };
  }
  for (const event of feed.events) {
    if (event.id > cursor.id) { cursor.id = event.id; cursor.ts = event.ts; }
  }
  const messages = feed.events.filter(event => event.by === "hub:duty" && now - event.ts < 24 * 3600 * 1000)
    .map(event => ({ from: event.by, text: event.text, ts: event.ts }));
  const resolved = new Map();
  for (const { recipient } of dutyEscalations(messages)) {
    if (resolved.has(recipient)) continue;
    const target = resolver(recipient);
    // #12092: a local idle session with no usable socket is reported, never dropped silently; the
    // cursor has moved past this alert so it is not retried, and duty's own triage path stays open.
    if (target?.unreachable) log(`wake-nudge: ${recipient} unreachable: ${target.unreachable}; leaving it to the duty seat`);
    resolved.set(recipient, target?.unreachable ? null : target);
  }
  const reachable = messages.filter(message => {
    const item = dutyEscalations([message])[0];
    return item && !attempted.has(item.id) && resolved.get(item.recipient);
  });
  if (!reachable.length) return { nudged: [], missing: [] };
  const statePath = join(bus, "duty-nudged.json");
  const plan = await claimDutyNudges({ messages: reachable, statePath, owner: `wake:${process.pid}`, isDelivered: async ({ recipient, id }) => {
    const peer = await api(`/peer?session=${encodeURIComponent(recipient)}`);
    return Number(peer.deliveredUpTo || 0) >= Number(id);
  } });
  // #11355: the shared pre-send ledger — the duty path stamps the same files, so of the two
  // orchestrator-wake nudgers exactly one send per unread id lands; the loser logs and stands down.
  const skipped = [];
  for (const target of plan.targets) {
    const reserve = await reserveNudgeIds({ recipient: target.recipient, ids: target.ids, owner: `wake:${process.pid}`, bus, log });
    target.ids = reserve.allowed;
    skipped.push(...reserve.skipped.map(s => s.id));
  }
  plan.items = plan.items.filter(item => !skipped.includes(item.id));
  plan.targets = plan.targets.filter(target => target.ids.length);
  await releaseDutyNudgeClaims({ ids: skipped, statePath, owner: plan.owner });
  if (!plan.targets.length) return { nudged: [], missing: [] };
  const observedIds = new Set();
  let result;
  try {
    await Promise.all(plan.targets.map(async target => {
      for (const id of target.ids) attempted.add(id);
      const local = resolved.get(target.recipient);
      const before = Number(read(local.pollStamp));
      const postedAt = Date.now();
      const post = await postNudgeDetailed(local, target.ids);
      if (!post.ok) { log(`wake-nudge: ${target.recipient} socket post failed: ${post.reason}`); return; }
      while (Date.now() - postedAt < verifyMs) {
        const stamp = Number(read(local.pollStamp));
        if (stamp > before && stamp >= postedAt) {
          for (const id of target.ids) observedIds.add(id);
          return;
        }
        await sleep(100);
      }
      // #12092: written and closed, but the session never polled. The inbox gives no verdict on this
      // connection, so held (bypassPermissions receiver, crossSessionInbound hold), refused and dropped look alike.
      log(`wake-nudge: ${target.recipient} posted but not polled within ${verifyMs}ms: held, refused or dropped by the session (no verdict on this socket); duty keeps the triage path`);
    }));
    // #11355: a tick that ends with unverified sends releases their stamps — the ledger must
    // mirror the claim release below, or a failed send would silence the duty path for the TTL.
    for (const target of plan.targets) {
      const unverified = target.ids.filter(id => !observedIds.has(id));
      if (unverified.length) await releaseNudgeIds({ recipient: target.recipient, ids: unverified, owner: plan.owner, bus });
    }
  } finally {
    // #7429: release unverified claims so the duty seat retains its triage path.
    result = await auditDutyNudges({ plan, observedIds, statePath, reportFailure: async () => {} });
  }
  return result;
}

function fleetHub(args) {
  const at = args.indexOf("--hub");
  if (at >= 0 && args[at + 1]) return args[at + 1];
  const config = readConfig();
  const counts = new Map();
  for (const hub of Object.values(config.hubs || {})) counts.set(hub, (counts.get(hub) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || config.url || "http://127.0.0.1:4477";
}

export async function runDuty(args) {
  const cmd = args[0] || "status";
  const execute = (script, argv) => new Promise(resolve => {
    const child = spawn(process.execPath, [join(dirname(SELF), script), ...argv], { stdio: "inherit" });
    child.on("error", error => { console.error(error.message); resolve(1); });
    child.on("exit", code => resolve(code ?? 1));
  });
  const wakeArgs = [cmd, "--hub", fleetHub(args)];
  const supported = ["up", "down", "status"].includes(cmd) && process.platform === "darwin";
  const wakeCode = supported && cmd === "down" ? await execute("wake-nudge.mjs", wakeArgs) : 0;
  const dutyCode = await execute("duty.mjs", args);
  if (supported && (cmd === "status" || (cmd === "up" && dutyCode === 0))) {
    return (await execute("wake-nudge.mjs", wakeArgs)) || dutyCode;
  }
  return dutyCode || wakeCode;
}

const xml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
export function keepalivePlist({ bus, hub, home = homedir(), node = process.execPath, script = SELF, path = process.env.PATH }) {
  const args = [node, script, "run", "--hub", hub];
  const env = { AGENT_BUS_DIR: bus, HOME: home, PATH: path };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(bus, "wake-nudge.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(bus, "wake-nudge.log"))}</string>
</dict></plist>\n`;
}

async function main() {
  const [cmd = "status", ...args] = process.argv.slice(2);
  const hub = fleetHub(args);
  const bus = busDir();
  const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const service = `gui/${process.getuid()}/${LABEL}`;
  if (cmd === "up") {
    if (process.platform !== "darwin") throw new Error("wake-nudge keepalive requires launchd");
    if (!load("claude:trantor-duty")) throw new Error("existing duty identity required; run trantor duty up first");
    mkdirSync(bus, { recursive: true });
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, keepalivePlist({ bus, hub }), { mode: 0o600 });
    try { run("launchctl", ["bootout", service]); } catch { /* #7429: first install has no prior service. */ }
    run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist]);
    console.log(`${LABEL} installed; polling ${hub}`);
  } else if (cmd === "down") {
    try { run("launchctl", ["bootout", service]); } catch { /* #7429: stop is idempotent. */ }
    rmSync(plist, { force: true });
    console.log(`${LABEL} stopped`);
  } else if (cmd === "status") {
    console.log(existsSync(plist) ? run("launchctl", ["print", service]) : `${LABEL} not installed`);
  } else if (cmd === "run" || cmd === "once") {
    const identity = load("claude:trantor-duty");
    if (!identity) throw new Error("existing duty identity required");
    mkdirSync(bus, { recursive: true });
    const api = async path => {
      const response = await sfetchJson(`${hub}${path}`, { method: "GET", identity, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`hub read failed: ${response.status}`);
      return response.json();
    };
    const attempted = new Set();
    const cursorPath = join(bus, "wake-nudge-cursor.json");
    let cursor = { hub, id: 0, ts: 0 };
    try {
      const saved = JSON.parse(read(cursorPath));
      if (saved.hub === hub && Number.isSafeInteger(saved.id) && saved.id >= 0) cursor = saved;
    } catch { /* #7429: first start reads the retained alert window once. */ }
    do {
      // #7429: a held recipient's verification must not delay polling for other alerts.
      const tick = wakeOnce({ api, bus, attempted, cursor }).then(result => {
        const temporary = `${cursorPath}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(cursor) + "\n", { mode: 0o600 });
        renameSync(temporary, cursorPath);
        if (result.nudged.length || result.missing.length) console.log(JSON.stringify(result));
      }).catch(error => {
        console.error(error.message);
        if (cmd === "once") throw error;
      });
      if (cmd === "once") await tick;
      if (cmd === "run") await sleep(5000);
    } while (cmd === "run");
  } else throw new Error("usage: node bin/wake-nudge.mjs up|down|status|run|once [--hub URL]");
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) main().catch(error => { console.error(error.message); process.exitCode = 1; });
