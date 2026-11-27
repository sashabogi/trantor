import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

export class BrowserError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class SocketTimeout extends BrowserError {
  constructor(op) {
    super("timeout", `Browser ${op} timed out`);
  }
}

class WaitTimeout extends BrowserError {}

const waiting = new Set(["held_by_user", "waiting_for_approval"]);
const waitReason = code => code === "held_by_user"
  ? "the operator to give back the browser"
  : "the operator to approve browser access";

function request(socketPath, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "", settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new SocketTimeout(payload.op)), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("error", error => finish(["ENOENT", "ECONNREFUSED"].includes(error.code)
      ? new BrowserError("no_app", "Trantor's desktop app is not open on this machine")
      : error));
    socket.on("end", () => finish(new BrowserError("connection_closed", "The browser socket closed before replying")));
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); }
      catch { finish(new BrowserError("bad_response", "The browser socket returned invalid JSON")); return; }
      if (!response || response.id !== payload.id || ![true, false].includes(response.ok)) {
        finish(new BrowserError("bad_response", "The browser socket returned an invalid response"));
      } else if (!response.ok) {
        finish(new BrowserError(response.error, response.message));
      } else {
        const { id, ok, ...result } = response;
        finish(null, result);
      }
    });
  });
}

export function createBrowserClient({ session, label, project,
  busDir = process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"),
  timeoutMs = 30_000, waitMs = 120_000, pollMs = 1_000,
}) {
  const socketPath = join(busDir, "browser.sock");
  const send = (op, args, limit = timeoutMs) => request(socketPath,
    { ...args, id: randomUUID(), session, label, project, op }, limit);

  return async (op, args = {}, onWaiting = async () => {}) => {
    let blocked;
    try { return await send(op, args); }
    catch (error) {
      if (!waiting.has(error.code)) throw error;
      blocked = error;
    }
    const deadline = Date.now() + waitMs;
    const expired = () => new WaitTimeout(blocked.code,
      `Waited ${waitMs / 1000}s for ${waitReason(blocked.code)}. ${blocked.message}`);
    const sendWhileWaiting = async (nextOp, nextArgs) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw expired();
      try { return await send(nextOp, nextArgs, Math.min(timeoutMs, remaining)); }
      catch (error) {
        if (error instanceof SocketTimeout && remaining <= timeoutMs) throw expired();
        throw error;
      }
    };
    await onWaiting(`Waiting for ${waitReason(blocked.code)}. ${blocked.message}`);
    while (Date.now() < deadline) {
      await sleep(Math.min(pollMs, deadline - Date.now()));
      if (Date.now() >= deadline) break;
      try {
        const stateArgs = args.page === undefined ? {} : { page: args.page };
        const state = await sendWhileWaiting("state", stateArgs);
        if (state.held_by_user) {
          if (blocked.code !== "held_by_user") {
            blocked = new BrowserError("held_by_user", "The operator has taken over the browser");
            await onWaiting(`Waiting for ${waitReason(blocked.code)}. ${blocked.message}`);
          }
          continue;
        }
        if (Date.now() >= deadline) break;
        // Approval is not in BrowserState; retrying the op observes the operator's answer.
        return await sendWhileWaiting(op, args);
      } catch (error) {
        if (error instanceof WaitTimeout || !waiting.has(error.code)) throw error;
        if (blocked.code !== error.code) await onWaiting(`Waiting for ${waitReason(error.code)}. ${error.message}`);
        blocked = error;
      }
    }
    throw expired();
  };
}
