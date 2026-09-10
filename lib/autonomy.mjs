// How much Trantor is allowed to do without asking. THREE dials, not one: `harness` (does the
// operator's claude ask), `acts` (what Trantor does on your behalf), and the crew agent's
// unattended level, which lives on the HUB as team state, not here. Shared on disk because the
// app writes it and crew.mjs + the runner read it. Seams: docs/CONTRACT-lib.md.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const AUTONOMY_PATH = () =>
  join(process.env.AGENT_BUS_DIR || join(homedir(), ".agent-bus"), "autonomy.json");

/** Conservative by design. A fresh install must never commit, push or deploy on its own — the
 *  operator turns each of those on deliberately, having been told what it means. */
export const DEFAULTS = Object.freeze({
  harness: "prompt",    // prompt | bypass
  commit: false,
  push: false,
  deploy: false,
  swapDeadSeat: true,   // replacing an exhausted seat costs nothing and loses nothing
  retryFailedTurn: true,
  // Who pulls the handoff trigger at the warn line (#5509 W2, SYSTEM-CONTRACT §5): "ask" = the
  // app's banner asks and the heartbeat neither arms nor fires; "auto" = arm-at-warn, fire-at-
  // boundary. PreCompact stays the at-the-wall backstop in BOTH modes.
  baton: "ask",         // ask | auto
});

const HARNESS = ["prompt", "bypass"];
const BATON = ["ask", "auto"];

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

/** The answer for ONE project: its override on top of the defaults, with dependencies enforced on
 *  READ (push implies commit, deploy implies push) so a hand-edited file cannot smuggle a state
 *  the UI would refuse to produce. */
export function resolveAutonomy(project, cfg = loadAutonomy()) {
  const merged = { ...cfg.defaults, ...(cfg.projects?.[project] || {}) };
  const out = {
    harness: HARNESS.includes(merged.harness) ? merged.harness : DEFAULTS.harness,
    commit: !!merged.commit,
    push: !!merged.push,
    deploy: !!merged.deploy,
    swapDeadSeat: merged.swapDeadSeat !== false,
    retryFailedTurn: merged.retryFailedTurn !== false,
    baton: BATON.includes(merged.baton) ? merged.baton : DEFAULTS.baton,
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
