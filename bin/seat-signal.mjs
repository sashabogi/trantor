#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { basename } from "node:path";

const [command, ...args] = process.argv.slice(2);
const refuse = reason => { throw new Error(reason); };

function signalValue(value) {
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (n === 0 || Object.values(constants.signals).includes(n)) return n;
  }
  const name = value.toUpperCase().replace(/^SIG/, "");
  if (constants.signals[`SIG${name}`]) return constants.signals[`SIG${name}`];
  return refuse("unknown signal");
}

function processTable() {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 5000 });
  if (ps.error || ps.status !== 0) refuse("cannot inspect process ancestry");
  const rows = new Map();
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match) rows.set(Number(match[1]), { parent: Number(match[2]), name: basename(match[3].trim()) });
  }
  return rows;
}

function descendant(pid, root, rows) {
  const seen = new Set();
  while (pid !== root && rows.has(pid) && !seen.has(pid)) {
    seen.add(pid);
    pid = rows.get(pid).parent;
  }
  return seen.size > 0 && pid === root;
}

function targets(rows) {
  let signal = constants.signals.SIGTERM;
  let at = 0;
  if (["-s", "--signal"].includes(args[at])) {
    if (!args[at + 1]) refuse("missing signal");
    signal = signalValue(args[at + 1]); at += 2;
  } else if (/^-(?:\d+|(?:SIG)?[A-Z]+)$/i.test(args[at] || "") && !/^-[fix]+$/.test(args[at])) {
    signal = signalValue(args[at].slice(1)); at++;
  }
  if (command === "kill") {
    if (args[at] === "--") at++;
    const pids = args.slice(at);
    if (!pids.length || pids.some(p => !/^[1-9]\d*$/.test(p) || !Number.isSafeInteger(Number(p)))) {
      refuse("kill requires positive PIDs; process groups and job specs are refused");
    }
    return { signal, pids: pids.map(Number) };
  }
  if (command === "pkill") {
    const flags = [];
    while (/^-[fix]+$/.test(args[at] || "")) flags.push(args[at++]);
    if (args.length - at !== 1 || args[at].startsWith("-")) {
      refuse("pkill requires options before one pattern; ambiguous or unsupported arguments");
    }
    // pgrep resolves native regex semantics without ever invoking the signalling binary.
    const result = spawnSync("/usr/bin/pgrep", [...flags, args[at]], { encoding: "utf8", timeout: 5000 });
    if (result.error || ![0, 1].includes(result.status)) refuse("cannot resolve pkill pattern");
    return { signal, pids: result.stdout.trim().split(/\s+/).filter(Boolean).map(Number) };
  }
  if (command === "killall") {
    const names = args.slice(at);
    if (!names.length || names.some(name => name.startsWith("-") || name.includes("/"))) {
      refuse("killall requires exact process names; unsupported arguments");
    }
    return { signal, pids: [...rows].filter(([, row]) => names.includes(row.name)).map(([pid]) => pid) };
  }
  return refuse("unknown signal command");
}

try {
  const root = Number(process.env.TRANTOR_SIGNAL_ROOT);
  if (!Number.isSafeInteger(root) || root <= 1) refuse("missing seat process root");
  const rows = processTable();
  if (!descendant(process.pid, root, rows)) refuse("guard is outside the seat process tree");
  const selected = targets(rows);
  const pids = [...new Set(selected.pids)].filter(pid => pid !== process.pid);
  if (!pids.length) process.exit(1);
  for (const pid of pids) {
    if (!descendant(pid, root, rows)) refuse(`PID ${pid} is outside the seat process tree`);
  }
  // Recheck the whole set before sending anything; never partially apply a broad match.
  const current = processTable();
  for (const pid of pids) {
    if (!descendant(pid, root, current)) refuse(`PID ${pid} left the seat process tree`);
  }
  for (const pid of pids) process.kill(pid, selected.signal);
} catch (error) {
  console.error(`seat signal guard: refused ${command}: ${error.message}`);
  process.exitCode = 1;
}
