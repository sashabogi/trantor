import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { loadOrCreate } from "../../lib/identity.mjs";
import { ensureEnrolled } from "../../lib/enroll.mjs";
import { sfetchJson } from "../../lib/signed-fetch.mjs";

// A replacement registers before it touches the old runner's worktree or queue.
export async function awaitSwapRelease(env = process.env) {
  if (!env.CREW_SWAP_STAGE) return;
  const stage = env.CREW_SWAP_STAGE;
  const session = `${env.CREW_SWAP_LABEL}:${env.RELAY_PROJECT}`;
  const identity = loadOrCreate(session, "agent");
  const enrollment = await ensureEnrolled(env.RELAY_URL, identity, env.RELAY_PROJECT);
  if (!enrollment.ok) throw new Error(`replacement enrollment failed: ${enrollment.reason}`);
  const response = await sfetchJson(`${env.RELAY_URL}/register`, {
    identity, payload: { session, project: env.RELAY_PROJECT, kind: "agent", status: "replacement ready; awaiting handoff" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`replacement registration failed: ${response.status}`);
  writeFileSync(`${stage}.ready`, JSON.stringify({ pid: process.pid, session }));
  const deadline = Date.now() + 120000;
  while (!existsSync(`${stage}.release`)) {
    if (Date.now() > deadline) throw new Error("swap handoff timed out; replacement stopped before taking work");
    await setTimeout(100);
  }
  const handoff = JSON.parse(readFileSync(`${stage}.release`, "utf8"));
  if (handoff.agent !== env.CREW_SWAP_AGENT) throw new Error("swap release names a different seat");
}
