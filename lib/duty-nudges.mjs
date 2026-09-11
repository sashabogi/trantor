import {
  closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ID_RE = /#([A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*)/g;
// The reason persisted for a recipient no local session resolves to: terminal, never retried (#7430).
export const DUTY_NO_SESSION_REASON = "no local session";

function idsIn(text) {
  return [...String(text || "").matchAll(ID_RE)].map(match => match[1]);
}

function projectOf(recipient) {
  const at = String(recipient || "").lastIndexOf(":");
  return at >= 0 ? recipient.slice(at + 1) : "";
}

export function dutyEscalations(messages) {
  const found = [];
  for (const message of messages || []) {
    if (message?.from !== "hub:duty") continue;
    const text = String(message.text || "");
    if (!/\bUNDELIVERED\b/.test(text)) continue;
    const match = /\bUNDELIVERED\b[\s\S]*?#([A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*)\s+\S+\s+(?:->|→)\s+([^\s—]+)/.exec(text);
    if (!match) continue;
    const recipient = match[2].replace(/[),.;]+$/, "");
    found.push({ id: match[1], recipient, project: projectOf(recipient) });
  }
  return found;
}

export function readDutyNudgeState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!(parsed?.nudged instanceof Object) || Array.isArray(parsed.nudged)) throw new Error("invalid nudged state");
    if (!(parsed.planned instanceof Object) || Array.isArray(parsed.planned)) parsed.planned = {};
    return parsed;
  } catch {
    return { version: 1, nudged: {}, planned: {} };
  }
}

function groupByRecipient(items) {
  const targets = [];
  for (const item of items) {
    let target = targets.find(candidate => candidate.recipient === item.recipient);
    if (!target) {
      target = { recipient: item.recipient, project: item.project, ids: [] };
      targets.push(target);
    }
    if (!target.ids.includes(item.id)) target.ids.push(item.id);
  }
  return targets;
}

function buildPlan(items, owner = "", noops = [], terminal = []) {
  return {
    items, targets: groupByRecipient(items), owner,
    noops: groupByRecipient(noops), terminal: groupByRecipient(terminal),
  };
}

// #7430: pre-flight every recipient BEFORE it becomes a mandatory nudge. A recipient observed busy
// is a no-op (rule 4a says the same, so prompt and audit can no longer disagree); a recipient no
// local session resolves to is terminal. A resolver that throws or says nothing fails OPEN to
// "nudge stands" — the missed nudge is always worse than a redundant one.
async function resolveItems(escalations, resolveRecipient = null) {
  const actionable = [], noops = [], terminal = [];
  if (!resolveRecipient) {
    actionable.push(...escalations);
    return { actionable, noops, terminal };
  }
  for (const item of escalations) {
    let verdict = "idle";
    try { verdict = await resolveRecipient(item.recipient); } catch { verdict = "idle"; }
    if (verdict === "busy") noops.push(item);
    else if (verdict === "unknown") terminal.push(item);
    else actionable.push(item);
  }
  return { actionable, noops, terminal };
}

export async function planDutyNudges(messages, statePath, deps = {}) {
  const state = readDutyNudgeState(statePath);
  const resolved = await resolveItems(dutyEscalations(messages), deps.resolveRecipient);
  const items = resolved.actionable.filter(item => !state.nudged[item.id] && !state.planned[item.id]);
  return buildPlan(items, "", resolved.noops, resolved.terminal);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Drop escalations whose recipient already read the message: a nudge wakes a session (#7131).
 * `isDelivered` is injected (the runner passes /peer, singular); unknown is never treated as delivered.
 */
async function dropDelivered(items, isDelivered) {
  if (!items.length) return items;
  const kept = [];
  for (const item of items) {
    let delivered = false;
    try { delivered = (await isDelivered(item)) === true; } catch { delivered = false; }
    if (!delivered) kept.push(item);
  }
  return kept;
}

// `isDelivered` defaults to "never delivered", which is the pre-check behaviour: no checker means
// every escalation stands. Making the absent case a real function rather than a typeof test keeps
// the contract in the signature instead of in a branch.
export async function claimDutyNudges({ messages, statePath, owner, pid = process.pid, now = Date.now(), isDelivered = async () => false, resolveRecipient = null }) {
  let plan = buildPlan([], owner);
  // Re-check BEFORE taking the lock: the hub calls are the slow part (delivery read + recipient
  // resolution), and holding a file lock across them would serialise every concurrent wake behind
  // the network.
  const live = await dropDelivered(dutyEscalations(messages), isDelivered);
  const liveIds = new Set(live.map(item => item.id));
  const resolved = await resolveItems(
    dutyEscalations(messages).filter(item => liveIds.has(item.id)), resolveRecipient);
  await withStateLock(statePath, state => {
    for (const [id, claim] of Object.entries(state.planned)) {
      if (now - Number(claim?.plannedAt || 0) > 30 * 60 * 1000 || !processAlive(Number(claim?.pid || 0))) {
        delete state.planned[id];
      }
    }
    const items = resolved.actionable.filter(item =>
      !state.nudged[item.id] && !state.planned[item.id]);
    plan = buildPlan(items, owner,
      resolved.noops.filter(item => !state.nudged[item.id]),
      resolved.terminal.filter(item => !state.nudged[item.id]));
    for (const item of items) {
      state.planned[item.id] = {
        owner, pid, recipient: item.recipient, project: item.project, plannedAt: now,
      };
    }
    // #7430: unresolvable recipients go terminal in the SAME map a verified nudge fills, so the
    // planning filter drops them from every future turn — recorded with a reason, never a retry.
    // Busy ids get NO record: a busy session can go idle, so the next turn re-resolves it.
    for (const item of resolved.terminal) {
      if (!state.nudged[item.id]) {
        state.nudged[item.id] = {
          recipient: item.recipient, project: item.project, nudgedAt: now,
          terminal: true, reason: DUTY_NO_SESSION_REASON,
        };
      }
      delete state.planned[item.id];
    }
  });
  return plan;
}

export function dutyNudgeDirective(plan) {
  const blocks = [];
  if (plan?.targets?.length) {
    const targets = plan.targets.map(target =>
      `- ${target.recipient}: ${target.ids.map(id => `#${id}`).join(", ")}`,
    ).join("\n");
    blocks.push(`\nMECHANICAL DUTY NUDGE REQUIREMENT (runner-enforced):\n${targets}\nEvery id above is NEW and has no verified socket nudge in ~/.agent-bus/duty-nudged.json. Use ListAgents to resolve each local session and call SendMessage for EVERY listed id before ending this turn. A prior nudge to the same target does not cover a new id; the metronome rule applies only to the SAME id. The runner verifies actual SendMessage tool calls, records successful ids, and reports any omitted ids through /duty/failure. Your only discretion is the content-free nudge wording.\n`);
  }
  // #7430: the runner already resolved these recipients, so the audit will NEVER count them
  // missing — say so plainly so rule 4a and this directive cannot be read against each other.
  if (plan?.noops?.length) {
    const noops = plan.noops.map(target =>
      `- ${target.recipient}: ${target.ids.map(id => `#${id}`).join(", ")}`,
    ).join("\n");
    blocks.push(`\nNO-OP (the runner observed these recipients BUSY — they will read their inbox on their next turn; do NOT nudge them, and omitting them is never a failure):\n${noops}\n`);
  }
  if (plan?.terminal?.length) {
    const gone = plan.terminal.map(target =>
      `- ${target.recipient}: ${target.ids.map(id => `#${id}`).join(", ")}`,
    ).join("\n");
    blocks.push(`\nTERMINAL (no local session resolves for these recipients — the runner recorded them in duty-nudged.json; a nudge is neither possible nor required):\n${gone}\n`);
  }
  return blocks.join("");
}

export function claudeTranscriptDir(turnDir, homeDir) {
  return join(homeDir, ".claude", "projects", turnDir.replace(/[^a-zA-Z0-9]/g, "-"));
}

function toolUses(value, found) {
  if (!(value instanceof Object)) return;
  if (value.type === "tool_use" && value.name === "SendMessage") found.push(value);
  for (const child of Object.values(value)) {
    if (child instanceof Object) toolUses(child, found);
  }
}

export function observedDutyNudgeIds(transcriptDir, sinceMs) {
  if (!existsSync(transcriptDir)) return new Set();
  const ids = new Set();
  for (const name of readdirSync(transcriptDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(transcriptDir, name);
    try {
      if (statSync(path).mtimeMs < sinceMs) continue;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        const row = JSON.parse(line);
        const timestamp = Date.parse(row.timestamp || "");
        if (Number.isFinite(timestamp) && timestamp < sinceMs) continue;
        const uses = [];
        toolUses(row, uses);
        for (const use of uses) {
          const input = use.input || {};
          const text = String(input.message || input.content || "");
          if (!text.startsWith("Trantor delivery nudge from the duty seat:")
            || !text.endsWith("This nudge carries no message content; the signed bus messages are the source of truth.")) continue;
          for (const id of idsIn(text)) ids.add(id);
        }
      }
    } catch {}
  }
  return ids;
}

function writeDutyNudgeState(path, state) {
  const entries = Object.entries(state.nudged)
    .sort((a, b) => Number(b[1]?.nudgedAt || 0) - Number(a[1]?.nudgedAt || 0))
    .slice(0, 5000);
  const next = { version: 1, nudged: Object.fromEntries(entries), planned: state.planned || {} };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function withStateLock(path, update) {
  const lockPath = `${path}.lock`;
  let lock = null;
  for (let attempt = 0; attempt < 100 && lock === null; attempt++) {
    try { lock = openSync(lockPath, "wx", 0o600); }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  if (lock === null) throw new Error(`could not lock ${path}`);
  try {
    const state = readDutyNudgeState(path);
    await update(state);
    writeDutyNudgeState(path, state);
  } finally {
    closeSync(lock);
    try { unlinkSync(lockPath); } catch {}
  }
}

export async function recordDutyNudges({ plan, observedIds, statePath, now = Date.now() }) {
  const nudged = plan.items.filter(item => observedIds.has(item.id));
  if (!nudged.length) return [];
  await withStateLock(statePath, state => {
    for (const item of nudged) {
      state.nudged[item.id] = { recipient: item.recipient, project: item.project, nudgedAt: now };
      delete state.planned[item.id];
    }
  });
  return nudged;
}

export async function auditDutyNudges({ plan, observedIds, statePath, reportFailure, now = Date.now() }) {
  const nudged = await recordDutyNudges({ plan, observedIds, statePath, now });
  const missing = plan.targets.map(target => ({
    ...target,
    ids: target.ids.filter(id => !observedIds.has(id)),
  })).filter(target => target.ids.length);
  for (const target of missing) await reportFailure(target);
  if (missing.length) {
    const missingIds = new Set(missing.flatMap(target => target.ids));
    await withStateLock(statePath, state => {
      for (const id of missingIds) {
        if (state.planned[id]?.owner === plan.owner) delete state.planned[id];
      }
    });
  }
  return { missing, nudged };
}
