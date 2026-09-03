#!/usr/bin/env node
// trantor genesis-kickoff [<project>] — which boot prompt a WOKEN orchestrator gets (#6112).
//
// Two paths into a project (operator ruling 2026-09-02 23:15). Path A, blank: the orchestrator
// wakes plainly and works iteratively with the operator. Path B, from a brief: the PRD sits in
// docs/PRD.md and the wake CONVENES the crew review (/trantor:prd-review) before anything is
// built. Waking an adopted project that has docs/PRD.md and no build cards takes path B too, so
// a project that parked with its PRD in place needs no re-genesis: the next Wake convenes it.
//
// The decision needs two facts only the CLI holds together — the checkout's durable docs/PRD.md
// and the project's SIGNED board — so it lives here. The desktop app (genesis sheet, sidebar
// Wake, workspace open) runs this in the checkout and relays the one line it prints; on exit 1
// the app types its own plain wake instead. A board that cannot be read therefore fails CLOSED
// to the plain wake, never to a review nobody verified was due: the plain-woken orchestrator
// still sees docs/PRD.md and the CLAUDE.md pointer and can convene by hand.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIdentity, signedGet } from "../hooks/lib/api.mjs";
import { ensureEnrolled as enrollViaOwnerInvite } from "../lib/enroll.mjs";
import { hostId, resolveHub, resolveProject } from "../lib/project.mjs";

export const PRD_REVIEW_KICKOFF = "docs/PRD.md is the brief; run /trantor:prd-review";
// Word for word the app's WAKE_KICKOFF_PROMPT (desktop terminal.rs): a project without a brief to
// review gets exactly the wake it always got.
export const PLAIN_WAKE_KICKOFF = "You were just woken via Trantor. Catch up from your context — the handoff you were handed if one exists, otherwise the project board and memory — then recap where things stand in at most 3 sentences and wait.";

// Cards that exist BEFORE a build starts, and must not be mistaken for one: the genesis card
// `trantor new` opens, the review cards this flow opens, and the auto-cards a session sheds
// (operator prompts, sub-agents) which say a conversation happened, not that work was cut.
const PRE_BUILD_PHASES = new Set(["genesis", "prd", "tdd"]);
const PRE_BUILD_TITLE = /^(genesis:|prd review:|tdd review:)/i;
const CONVERSATION_SOURCES = new Set(["session", "cc-subagent", "cc-bg-agent"]);

export function isBuildCard(task) {
  if (!task || typeof task !== "object") return false;
  const phase = String(task.phase || "").trim().toLowerCase();
  if (phase === "build") return true;
  if (PRE_BUILD_PHASES.has(phase)) return false;
  if (CONVERSATION_SOURCES.has(String(task.source || "").trim().toLowerCase())) return false;
  const title = String(task.title || "").trim();
  return Boolean(title) && !PRE_BUILD_TITLE.test(title);
}

// The pure decision: dir = the checkout, tasks = the board (an array), or null when it could not
// be read. Exported so the drill can pin every branch without a hub.
export function selectGenesisKickoff({ dir, tasks }) {
  if (!existsSync(join(dir, "docs", "PRD.md"))) return PLAIN_WAKE_KICKOFF;
  if (!Array.isArray(tasks)) return PLAIN_WAKE_KICKOFF;
  return tasks.some(isBuildCard) ? PLAIN_WAKE_KICKOFF : PRD_REVIEW_KICKOFF;
}

async function readBoard(project) {
  const hub = resolveHub(project);
  // Sign as the identity the orchestrator in this checkout will use (RELAY_SESSION when a runner
  // set one, else host:project). On an enforce hub that identity may be brand new for a project
  // `trantor new` made seconds ago, and TOFU is refused there — so enrol the way crew seats and
  // genesis itself do: the operator's owner key mints a project-scoped invite and this identity
  // spends it. A no-op when the hub already knows us; a soft failure when it does not, in which
  // case the signed read below reports the refusal and the caller falls back.
  const session = process.env.RELAY_SESSION
    || (process.env.RELAY_AGENT ? `${process.env.RELAY_AGENT}:${project}` : `${hostId()}:${project}`);
  const identity = loadIdentity(session);
  const enrolment = await enrollViaOwnerInvite(hub, identity, project, { timeoutMs: 4000 });
  if (!enrolment.ok && enrolment.reason !== "no-owner-key") {
    console.error(`genesis kickoff: enrolment on ${hub} did not succeed (${enrolment.reason}); trying the read anyway`);
  }
  const response = await signedGet(`/tasks?project=${encodeURIComponent(project)}`, { session, project, timeoutMs: 4000 });
  if (!response.ok) {
    return { ok: false, hub, reason: response.status ? `hub ${response.status}${response.json?.error ? `: ${response.json.error}` : ""}` : "unreachable" };
  }
  const tasks = Array.isArray(response.json) ? response.json : response.json?.tasks;
  return Array.isArray(tasks) ? { ok: true, hub, tasks } : { ok: false, hub, reason: "malformed /tasks response" };
}

async function main() {
  const dir = process.cwd();
  const project = process.argv[2] || resolveProject(dir);
  if (!existsSync(join(dir, "docs", "PRD.md"))) {
    console.log(PLAIN_WAKE_KICKOFF);
    return;
  }
  const board = await readBoard(project);
  if (!board.ok) {
    console.error(`genesis kickoff: docs/PRD.md is present but ${project}'s board on ${board.hub} could not be read (${board.reason}) — the app falls back to the plain wake`);
    process.exitCode = 1;
    return;
  }
  console.log(selectGenesisKickoff({ dir, tasks: board.tasks }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
