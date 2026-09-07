// #6668's built-app acceptance drill. TRANTOR_HANDOFF_DRILL=<project> makes Rust emit
// `handoff-drill` after boot (src-tauri/src/handoff_drill.rs); this opens that project's Chat
// the way the operator did on 09-07 12:35 — onto a pane holding a bare shell, with the newest
// transcript over the handoff threshold — and proves the machine does nothing: no banner, no
// chain, and a direct handoff_now is refused by the entry guard. The seat writes this drill but
// never launches it. The orchestrator stages the project and runs it.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { CHAT_TAB_SELECTOR, selectMode, selectProject, type AskDrillDeps } from "./askDrill";

/** How long the Chat gets to fire, if it is going to (the 12:35 chain fired within a second). */
const WATCH_MS = 20_000;
const POLL_MS = 250;
const BANNER_BUTTON_TEXTS = ["Hand off now", "handing off…"];

export type HandoffDrillDeps = AskDrillDeps;

const DEFAULT_DEPS: HandoffDrillDeps = {
  invoke: <T,>(cmd: string, args?: InvokeArgs) => invoke<T>(cmd, args),
  document,
  now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  armDeadline: (ms, expire) => {
    const timer = setTimeout(expire, ms);
    return () => clearTimeout(timer);
  },
};

/** handoff_drill_probe's answer: what this run's trace says about the project (camelCase from serde). */
export type HandoffDrillProbe = { chainStarted: boolean; withheld: boolean; refused: boolean };

export type HandoffDrillEvidence = {
  probe: HandoffDrillProbe;
  /** A handoff banner button was in the DOM at any point during the watch. */
  bannerSeen: boolean;
  /** What the direct handoff_now answered: the refusal text, or null when it resolved. */
  rejection: string | null;
};

/** The banner is in the DOM when a button carries one of its two labels. */
export function bannerShown(doc: Document): boolean {
  for (const button of doc.querySelectorAll<HTMLButtonElement>("button")) {
    const text = button.textContent?.trim() ?? "";
    if (BANNER_BUTTON_TEXTS.includes(text)) return true;
  }
  return false;
}

/** Pure: pass only when nothing fired AND the guard refused — the drill proves both legs. */
export function verdict(e: HandoffDrillEvidence): { pass: boolean; summary: string } {
  const problems: string[] = [];
  if (e.probe.chainStarted) problems.push("a chain started");
  if (e.bannerSeen) problems.push("the banner showed");
  if (!e.probe.withheld) problems.push("no withheld-gauge trace (is the staged transcript over the threshold?)");
  if (e.rejection === null) problems.push("handoff_now resolved instead of refusing");
  else if (!/no live agent/.test(e.rejection)) problems.push(`handoff_now rejected for another reason: ${e.rejection}`);
  if (!e.probe.refused) problems.push("no refusal trace");
  const facts = `chain=${e.probe.chainStarted} banner=${e.bannerSeen} withheld=${e.probe.withheld} refused=${e.probe.refused} rejection=${e.rejection === null ? "null" : JSON.stringify(e.rejection.slice(0, 160))}`;
  return problems.length
    ? { pass: false, summary: `${problems.join("; ")} — ${facts}` }
    : { pass: true, summary: `no banner, no chain, entry guard refused — ${facts}` };
}

function log(deps: HandoffDrillDeps, line: string): void {
  void deps.invoke("app_log", { line: `handoff-drill ${line}` }).catch(() => {});
}

async function probe(project: string, deps: HandoffDrillDeps): Promise<HandoffDrillProbe> {
  return deps.invoke<HandoffDrillProbe>("handoff_drill_probe", { project });
}

async function watch(project: string, deps: HandoffDrillDeps): Promise<{ bannerSeen: boolean; probe: HandoffDrillProbe }> {
  const deadline = deps.now() + WATCH_MS;
  let bannerSeen = false;
  let last = await probe(project, deps);
  while (deps.now() < deadline) {
    if (!bannerSeen && bannerShown(deps.document)) {
      bannerSeen = true;
      log(deps, "banner button appeared");
    }
    last = await probe(project, deps);
    // A chain is the failure itself; no point waiting out the clock on it.
    if (last.chainStarted) break;
    await deps.sleep(POLL_MS);
  }
  return { bannerSeen, probe: last };
}

export async function runHandoffDrill(project: string, deps: HandoffDrillDeps = DEFAULT_DEPS): Promise<void> {
  const name = project.trim();
  if (!name) {
    log(deps, "FAILED: payload has no project");
    return;
  }
  let evidence: HandoffDrillEvidence = {
    probe: { chainStarted: false, withheld: false, refused: false },
    bannerSeen: false,
    rejection: null,
  };
  try {
    await selectProject(name, deps);
    await selectMode(CHAT_TAB_SELECTOR, deps);
    log(deps, `chat open project=${name}; watching ${WATCH_MS}ms for a banner or a chain`);
    const watched = await watch(name, deps);
    log(deps, `watch done banner=${watched.bannerSeen} chain=${watched.probe.chainStarted} withheld=${watched.probe.withheld}`);
    const rejection = await deps.invoke<string>("handoff_now", { project: name, reason: "unattended" })
      .then(() => null, error => String(error));
    log(deps, `direct handoff_now -> ${rejection === null ? "resolved" : `rejected: ${rejection.slice(0, 200)}`}`);
    evidence = { probe: await probe(name, deps), bannerSeen: watched.bannerSeen, rejection };
  } catch (error) {
    evidence = { ...evidence, rejection: null };
    log(deps, `FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = verdict(evidence);
  log(deps, `${result.pass ? "PASS" : "FAIL"}: ${result.summary}`);
  await deps.invoke("handoff_drill_finish", { passed: result.pass, summary: result.summary }).catch(() => {});
}
