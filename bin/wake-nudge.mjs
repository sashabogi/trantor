#!/usr/bin/env node
// #7429: hub detection → local socket wake; the duty model handles unreachable recipients.
// up/down/status manage com.trantor.wake-nudge; run/once poll with the existing duty identity.
// --hub overrides config.hubs.trantor/config.url; AGENT_BUS_DIR controls ledger and log paths.
// Latency: hub UNDELIVERED after 2m → 2s event poll → socket → recipient inbox hook.

// #7429: read hub:duty events without consuming duty's inbox; ignore delivered/24h-old alerts.
// Resolve this host's idle Claude via herdr, the session map and an unambiguous process tree.
// Authenticate with its token, send ID-only NDJSON, and never inject terminal input or log tokens.
// Record only after its poll stamp advances within 10s; a poll proves activity, not a reply.

// #7429: failed/held attempts release claims to duty and are attempted once per daemon lifetime.
// Successful records deduplicate restarts; busy, remote and unresolved sessions fall through.
// Live drill: WAKE_NUDGE_LIVE=1 node --test test/crew/test-wake-nudge.mjs (artifacts: .agent-bus-out).
// KeepAlive + RunAtLoad use a 30s crash throttle; installation never enrolls a new identity.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { load } from "../lib/identity.mjs";
import { sfetchJson } from "../lib/signed-fetch.mjs";
import { busDir, hostId, readConfig } from "../lib/project.mjs";
import { ledgerPaths } from "../hooks/lib/inbox-ledger.mjs";
import { dutyEscalations, claimDutyNudges, auditDutyNudges } from "../lib/duty-nudges.mjs";

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

export function resolveRecipient(recipient, { bus = busDir(), localHost = hostId(), command = run, socketDir = "/tmp/cc-socks" } = {}) {
  if (!recipient.startsWith(`${localHost}:`)) return null;
  const project = recipient.slice(localHost.length + 1);
  const mapped = read(join(bus, "orch-sessions.txt")).split("\n").find(line => line.split("\t")[0] === project)?.split("\t")[1]?.trim();
  let agents = [];
  try { agents = JSON.parse(command("herdr", ["agent", "list"])).result.agents; } catch { /* #7429: map remains available without herdr. */ }
  const panes = agents.filter(agent => agent.agent === "claude" && (agent.agent_session?.value === mapped || agent.cwd?.split("/").pop() === project));
  if (panes.length > 1) return null;
  const pane = panes[0];
  if (["working", "busy"].includes(pane?.agent_status)) return null;
  const sid = pane?.agent_session?.value || mapped;
  if (!sid || !/^[\w-]+$/.test(sid)) return null;
  const rows = processRows(command("ps", ["-axo", "pid=,ppid=,command="]));
  let matches = rows.filter(row => claudeProcess(row.command) && new RegExp(`(?:--session-id|--resume|-r)\\s+${sid}(?:\\s|$)`).test(row.command));
  if (!matches.length && pane) {
    try {
      const info = JSON.parse(command("herdr", ["pane", "process-info", "--pane", pane.pane_id])).result.process_info;
      const pids = new Set(info.foreground_processes.filter(p => /^(claude|claude.exe)$/.test(p.name)).map(p => p.pid));
      matches = rows.filter(row => pids.has(row.pid) && claudeProcess(row.command));
    } catch { return null; }
  }
  if (matches.length !== 1) return null;
  const pid = matches[0].pid;
  const socketPath = join(socketDir, `${pid}.sock`);
  if (!existsSync(socketPath)) return null;
  // #7429: preserve ps's default columns for env; descendants must name this exact socket.
  for (const envPid of descendants(pid, rows)) {
    let token = "";
    try { token = tokenFromEnvironment(command("ps", ["eww", "-p", String(envPid)]), socketPath); } catch { continue; }
    if (token) return { pid, sid, token, socketPath, pollStamp: ledgerPaths(recipient, sid, bus).pollStamp };
  }
  return null;
}

export function postNudge({ socketPath, token, sid }, ids, timeoutMs = 1500) {
  const content = `<cross-session-message from="trantor:wake">\nYour Trantor bus inbox has unread message ids ${ids.map(id => `#${id}`).join(", ")}. Read them with relay_inbox and reply over the bus with relay_send. This nudge carries no message content; the signed bus messages are the source of truth.\n</cross-session-message>`;
  const lines = [{ type: "auth", token }, { type: "user", session_id: sid, message: { role: "user", content } }];
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    let sent = false;
    const finish = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.end(lines.map(line => JSON.stringify(line)).join("\n") + "\n", () => { sent = true; }));
    socket.on("close", hadError => finish(sent && !hadError));
  });
}

export async function wakeOnce({ api, bus = busDir(), resolver = recipient => resolveRecipient(recipient, { bus }), verifyMs = 10000, now = Date.now(), attempted = new Set() }) {
  const feed = await api("/events?type=message&by=hub%3Aduty&limit=2000");
  const messages = feed.events.filter(event => event.by === "hub:duty" && now - event.ts < 24 * 3600 * 1000)
    .map(event => ({ from: event.by, text: event.text, ts: event.ts }));
  const resolved = new Map();
  for (const { recipient } of dutyEscalations(messages)) {
    if (!resolved.has(recipient)) resolved.set(recipient, resolver(recipient));
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
  const observedIds = new Set();
  let result;
  try {
    await Promise.all(plan.targets.map(async target => {
      for (const id of target.ids) attempted.add(id);
      const local = resolved.get(target.recipient);
      const before = Number(read(local.pollStamp));
      const postedAt = Date.now();
      if (!await postNudge(local, target.ids)) return;
      while (Date.now() - postedAt < verifyMs) {
        const stamp = Number(read(local.pollStamp));
        if (stamp > before && stamp >= postedAt) {
          for (const id of target.ids) observedIds.add(id);
          return;
        }
        await sleep(100);
      }
    }));
  } finally {
    // #7429: release unverified claims so the duty seat retains its triage path.
    result = await auditDutyNudges({ plan, observedIds, statePath, reportFailure: async () => {} });
  }
  return result;
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
  const config = readConfig();
  const hubAt = args.indexOf("--hub");
  const hub = (hubAt >= 0 ? args[hubAt + 1] : "") || config.hubs?.trantor || config.url || "http://127.0.0.1:4477";
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
    do {
      // #7429: a held recipient's verification must not delay polling for other alerts.
      const tick = wakeOnce({ api, bus, attempted }).then(result => {
        if (result.nudged.length || result.missing.length) console.log(JSON.stringify(result));
      }).catch(error => {
        console.error(error.message);
        if (cmd === "once") throw error;
      });
      if (cmd === "once") await tick;
      if (cmd === "run") await sleep(2000);
    } while (cmd === "run");
  } else throw new Error("usage: node bin/wake-nudge.mjs up|down|status|run|once [--hub URL]");
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) main().catch(error => { console.error(error.message); process.exitCode = 1; });
