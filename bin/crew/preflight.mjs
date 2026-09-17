// #7760: `trantor up` used to hand out worktrees that could not build — every seat discovered the
// missing sibling package and the gitignored config at once. Up now provisions the first seat's
// worktree from .trantor/worktree.json, runs the declared preflight there once, and broadcasts.
import {
  PREFLIGHT_CAP_MS, applyWorktreeDeclaration, ensureSeatWorktree, preflightLine, provisioningLines,
  readWorktreeDeclaration, runPreflight,
} from "../../lib/seat-worktree.mjs";
import { gitRoot, hostId } from "../../lib/project.mjs";
import { loadOrCreate } from "../../lib/identity.mjs";
import { ensureEnrolled } from "../../lib/enroll.mjs";
import { sfetchJson } from "../../lib/signed-fetch.mjs";

const BROADCAST_MAX = 1500;

export function broadcastText(agent, applied, result) {
  const parts = [];
  if (result) parts.push(result.ok ? `${preflightLine(result)} in the ${agent} worktree` : `preflight failed in the ${agent} worktree (${result.command}): ${result.tail.join(" | ")}`);
  else parts.push(`worktree declaration applied for ${agent} (no preflight declared)`);
  if (applied.operator.length) parts.push(`operator steps: ${applied.operator.join("; ")}`);
  if (applied.problems.length) parts.push(`problems: ${applied.problems.join("; ")}`);
  const text = parts.join(" — ");
  return text.length > BROADCAST_MAX ? `${text.slice(0, BROADCAST_MAX - 1)}…` : text;
}

async function broadcast(ctx, text, log) {
  const session = ctx.env.RELAY_SESSION || `${hostId()}:${ctx.project}`;
  try {
    const identity = loadOrCreate(session, "agent");
    await ensureEnrolled(ctx.hub, identity, ctx.project);
    const r = await sfetchJson(`${ctx.hub}/send`, {
      identity, payload: { from: session, to: "all", project: ctx.project, kind: "status", text },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) log(`— preflight result NOT recorded on the bus (${ctx.hub}/send answered ${r.status}) —`);
    return r.ok;
  } catch (e) {
    log(`— preflight result NOT recorded on the bus (${String(e?.message || e).slice(0, 80)}) —`);
    return false;
  }
}

// Returns { skipped } when the project declares nothing (unchanged behaviour), else what was
// applied, the preflight result, and whether the bus recorded it.
export async function preflightFirstSeat(ctx, agent, { capMs = PREFLIGHT_CAP_MS, log = console.log } = {}) {
  const decl = readWorktreeDeclaration(gitRoot(ctx.dir) || ctx.dir);
  if (!decl) return { skipped: "no declaration" };
  const wt = ensureSeatWorktree({ sourceDir: ctx.dir, project: ctx.project, agent, home: ctx.home, env: ctx.env, log });
  if (!wt.root) {
    log(`— preflight skipped: no seat worktree for ${agent} (running from ${wt.dir}) —`);
    return { skipped: "no worktree" };
  }
  const applied = applyWorktreeDeclaration(decl, { root: wt.root, seatDir: wt.dir });
  log(`— ${agent} worktree ${wt.created ? "created" : "reused"} at ${wt.dir}; .trantor/worktree.json applied —`);
  for (const l of provisioningLines(applied, { prefix: "  " })) log(l);

  let result = null;
  if (!decl.preflight) log("— no preflight declared —");
  else if (wt.dirty) log(`— preflight skipped: the ${agent} worktree has uncommitted work (commit or harvest it, then re-run up) —`);
  else {
    log(`— preflight in ${wt.dir}: ${decl.preflight} (cap ${Math.round(capMs / 60000)} min) —`);
    result = runPreflight(decl.preflight, { seatDir: wt.dir, capMs, env: ctx.env });
    log(result.ok ? `\x1b[32m${preflightLine(result)}\x1b[0m` : `\x1b[31m${preflightLine(result)}\x1b[0m`);
    if (!result.ok) log("  ✗ fix the worktree need above (or the declaration) BEFORE writing contracts — the seats will hit the same wall.");
  }

  const worthPosting = result || applied.operator.length || applied.problems.length;
  const text = worthPosting ? broadcastText(agent, applied, result) : "";
  const posted = text ? await broadcast(ctx, text, log) : false;
  return { applied, result, text, posted, seatDir: wt.dir, created: wt.created };
}
