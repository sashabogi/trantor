import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { constants, cpus, homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const waitArray = new Int32Array(new SharedArrayBuffer(4));

function busDir(env) {
  return env.AGENT_BUS_DIR || env.RELAY_DATA_DIR || join(homedir(), ".agent-bus");
}

function slotCount(env) {
  try {
    const value = JSON.parse(readFileSync(join(busDir(env), "config.json"), "utf8")).heavyGateSlots;
    if (Number.isSafeInteger(value) && value > 0) return value;
  } catch {}
  return Math.max(1, Math.floor(cpus().length / 4));
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readSlot(path) {
  try {
    const row = JSON.parse(readFileSync(path, "utf8"));
    if (Number.isSafeInteger(row.pid) && Number.isFinite(row.startedAt)) return row;
  } catch {}
  return null;
}

function writeWait(waitFile, waitStarted, waiting) {
  if (!waitFile || waitStarted === null) return;
  const now = Date.now();
  const temporary = `${waitFile}.tmp`;
  mkdirSync(dirname(waitFile), { recursive: true });
  writeFileSync(temporary, JSON.stringify({
    pid: process.pid,
    waiting,
    updatedAt: now,
    totalMs: now - waitStarted,
  }));
  try { renameSync(temporary, waitFile); } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function acquire(slots, env) {
  const lockDir = join(busDir(env), "heavy-gate");
  mkdirSync(lockDir, { recursive: true });
  const waitDir = env.TRANTOR_HEAVY_GATE_WAIT_DIR;
  const waitFile = waitDir ? join(waitDir, `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`) : null;
  let waitStarted = null;
  let announced = false;
  let lastBeat = 0;
  let delay = 50;

  for (;;) {
    let inUse = 0;
    for (let index = 0; index < slots; index += 1) {
      const path = join(lockDir, `slot-${index}.json`);
      let fd;
      try {
        fd = openSync(path, "wx", 0o600);
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
        closeSync(fd);
        writeWait(waitFile, waitStarted, false);
        return { path, waitFile };
      } catch (error) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch {}
          try { unlinkSync(path); } catch {}
        }
        if (error?.code !== "EEXIST") throw error;
      }

      const row = readSlot(path);
      if (row && !pidAlive(row.pid)) {
        try { unlinkSync(path); } catch {}
        try {
          fd = openSync(path, "wx", 0o600);
          writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
          closeSync(fd);
          writeWait(waitFile, waitStarted, false);
          return { path, waitFile };
        } catch (error) {
          if (fd !== undefined) { try { closeSync(fd); } catch {} }
          if (error?.code !== "EEXIST") throw error;
        }
      }
      inUse += 1;
    }

    if (!announced) {
      waitStarted = Date.now();
      console.log(`waiting for a heavy-gate slot (${inUse} in use)`);
      announced = true;
    }
    const now = Date.now();
    if (now - lastBeat >= 1000) {
      writeWait(waitFile, waitStarted, true);
      lastBeat = now;
    }
    Atomics.wait(waitArray, 0, 0, delay);
    delay = Math.min(1000, Math.ceil(delay * 1.5));
  }
}

export function runHeavyGate(args, env = process.env) {
  const command = args[0] === "--" ? args.slice(1) : args;
  if (!command.length) {
    console.error("usage: heavy-gate.mjs -- <command> [args ...]");
    return 2;
  }

  let slot = null;
  if (env.TRANTOR_HEAVY_GATE_HELD !== "1") slot = acquire(slotCount(env), env);
  const childEnv = { ...env, TRANTOR_HEAVY_GATE_HELD: "1" };
  try {
    const result = spawnSync(command[0], command.slice(1), { env: childEnv, stdio: "inherit" });
    if (result.error) {
      console.error(`heavy-gate: ${result.error.message}`);
      return 127;
    }
    if (result.signal) return 128 + (constants.signals[result.signal] || 0);
    return result.status ?? 1;
  } finally {
    if (slot) {
      try { unlinkSync(slot.path); } catch {}
    }
  }
}
