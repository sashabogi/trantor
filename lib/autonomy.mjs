// How much Trantor is allowed to do without asking.
//
// THREE DIALS, not one. "How much autonomy" sounds like a single slider and is not: people
// routinely want their agents unsupervised, their own harness unprompted, and their remote
// untouched. Collapsing those into one control is how a product ends up pushing to main because
// someone wanted to skip permission prompts.
//
//   seats   — what a crew agent may do unattended
//   harness — whether the operator's own claude asks before acting
//   acts    — what TRANTOR ITSELF does on your behalf (commit, push, deploy, swap, retry)
//
// The file is shared state on purpose: the app writes it, crew.sh reads it when it starts your
// session, the runner reads it per turn. localStorage would have made the app's answer invisible
// to every other half of the product.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const AUTONOMY_PATH = () =>
  join(process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"), "autonomy.json");

/** Conservative by design. A fresh install must never commit, push or deploy on its own — the
 *  operator turns each of those on deliberately, having been told what it means. */
export const DEFAULTS = Object.freeze({
  seats: "propose",     // ask | propose | act
  harness: "prompt",    // prompt | bypass
  commit: false,
  push: false,
  deploy: false,
  swapDeadSeat: true,   // replacing an exhausted seat costs nothing and loses nothing
  retryFailedTurn: true,
});

const SEATS = ["ask", "propose", "act"];
const HARNESS = ["prompt", "bypass"];

export function loadAutonomy() {
  const p = AUTONOMY_PATH();
  if (!existsSync(p)) return { version: 1, defaults: { ...DEFAULTS }, projects: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return {
      version: 1,
      defaults: { ...DEFAULTS, ...(raw.defaults || {}) },
      projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {},
    };
  } catch {
    // A corrupt file must not hand out permissions nobody granted. Fall back to the safe defaults.
    return { version: 1, defaults: { ...DEFAULTS }, projects: {} };
  }
}

/** The answer for ONE project: its override on top of the defaults, with the dependencies between
 *  dials enforced. These are not preferences, they are the difference between a toggle and a
 *  loaded gun:
 *    - pushing what you never committed is meaningless, so push implies commit
 *    - deploying what you never pushed is meaningless, so deploy implies push
 *  Enforcing on READ rather than on write means a hand-edited file cannot smuggle a state the UI
 *  would refuse to produce. */
export function resolveAutonomy(project, cfg = loadAutonomy()) {
  const merged = { ...cfg.defaults, ...(cfg.projects?.[project] || {}) };
  const out = {
    seats: SEATS.includes(merged.seats) ? merged.seats : DEFAULTS.seats,
    harness: HARNESS.includes(merged.harness) ? merged.harness : DEFAULTS.harness,
    commit: !!merged.commit,
    push: !!merged.push,
    deploy: !!merged.deploy,
    swapDeadSeat: merged.swapDeadSeat !== false,
    retryFailedTurn: merged.retryFailedTurn !== false,
  };
  if (!out.commit) out.push = false;
  if (!out.push) out.deploy = false;
  return out;
}

/** Write one project's override, or the defaults when `project` is null. Returns the resolved
 *  result so a caller never has to guess what the dependencies did to its patch. */
export function setAutonomy(project, patch) {
  const cfg = loadAutonomy();
  if (project) cfg.projects[project] = { ...(cfg.projects[project] || {}), ...patch };
  else cfg.defaults = { ...cfg.defaults, ...patch };
  const p = AUTONOMY_PATH();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  return resolveAutonomy(project || "", cfg);
}

/** Is Trantor allowed to take this action here? Every autonomous act goes through this one
 *  question so the answer is auditable in one place rather than re-derived at each call site. */
export function mayAct(action, project) {
  const a = resolveAutonomy(project);
  switch (action) {
    case "commit": return a.commit;
    case "push": return a.push;
    case "deploy": return a.deploy;
    case "swap": return a.swapDeadSeat;
    case "retry": return a.retryFailedTurn;
    default: return false;
  }
}
