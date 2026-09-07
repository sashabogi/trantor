import {
  closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ID_RE = /#([A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*)/g;

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
    return parsed?.nudged instanceof Object && !Array.isArray(parsed.nudged)
      ? parsed
      : { version: 1, nudged: {} };
  } catch {
    return { version: 1, nudged: {} };
  }
}

export function planDutyNudges(messages, statePath) {
  const state = readDutyNudgeState(statePath);
  const items = dutyEscalations(messages).filter(item => !state.nudged[item.id]);
  const targets = [];
  for (const item of items) {
    let target = targets.find(candidate => candidate.recipient === item.recipient);
    if (!target) {
      target = { recipient: item.recipient, project: item.project, ids: [] };
      targets.push(target);
    }
    if (!target.ids.includes(item.id)) target.ids.push(item.id);
  }
  return { items, targets };
}

export function dutyNudgeDirective(plan) {
  if (!plan?.targets?.length) return "";
  const targets = plan.targets.map(target =>
    `- ${target.recipient}: ${target.ids.map(id => `#${id}`).join(", ")}`,
  ).join("\n");
  return `\nMECHANICAL DUTY NUDGE REQUIREMENT (runner-enforced):\n${targets}\nEvery id above is NEW and has no verified socket nudge in ~/.agent-bus/duty-nudged.json. Use ListAgents to resolve each local session and call SendMessage for EVERY listed id before ending this turn. A prior nudge to the same target does not cover a new id; the metronome rule applies only to the SAME id. The runner verifies actual SendMessage tool calls, records successful ids, and reports any omitted ids through /duty/failure. Your only discretion is the content-free nudge wording.\n`;
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
          if (!text.startsWith("Trantor delivery nudge from the duty seat:")) continue;
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
  const next = { version: 1, nudged: Object.fromEntries(entries) };
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
  return { missing, nudged };
}
