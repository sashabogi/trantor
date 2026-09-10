// How much Trantor is allowed to do without asking: the harness dial and the acts dial live here;
// the crew-agent dial is the overseer's per-project level on the hub (docs/CONTRACT-lib.md §autonomy).
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
  // Who fires the handoff at the context warn line (#5509, SYSTEM-CONTRACT §5): "ask" lets the app's
  // banner ask, "auto" arms at warn and fires at the turn boundary; PreCompact backstops both.
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

/** One project's answer: its override on the defaults, with push ⇒ commit and deploy ⇒ push enforced
 *  on READ so a hand-edited file cannot smuggle a state the UI would refuse. */
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
