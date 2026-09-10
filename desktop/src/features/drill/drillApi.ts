// Drill Mode (#6800): the side-effect seam, so the flow test hands in fakes: the disposable stage
// (trantor new), the card moves (on the trantor hub, NOT the stage project's), the screenshot
// (a Rust command), and the app-trace line that tells a drill close from a seat's.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { HubClient, hubForProject, knownProjects } from "../../shared/api/client";
import { CHAT_TAB_SELECTOR, selectMode, selectProject, type AskDrillDeps } from "../chat/askDrill";
import { TERMINAL_INPUT_SELECTOR, describeFocus, stageWorkspaceLens } from "../workspace/keyDrill";
import { DRILL_PROJECT_PREFIX, disposableProjectName, isDisposableProject } from "./drillSteps";
import type { AutoCheckKind, AutoCheckResult, DriveKind } from "./drillSteps";
import { runAutoCheck } from "./drillChecks";

/** The board the visual cards live on. The stage project is disposable; the cards are not. */
export const CARDS_PROJECT = "trantor";

export type DrillApi = {
  /** Find or create the disposable stage; resolves to its name (always drill-prefixed). */
  seedProject: () => Promise<string>;
  /** Move a card on the cards project's hub with the drill's note. */
  moveCard: (id: number, status: "done" | "doing", note: string) => Promise<void>;
  /** Capture the app window; resolves to the PNG path the card note cites. */
  screenshot: (label: string) => Promise<string>;
  /** Run one DOM probe against the live document. */
  autoCheck: (kind: AutoCheckKind) => AutoCheckResult;
  /** Let the browser paint (the panel hides itself) before the capture. */
  settle: () => Promise<void>;
  /** Run the step's driver on the operator's press; resolves to what it saw, which pre-fills
   *  the verdict the same way a DOM probe does. */
  drive: (kind: DriveKind, project: string) => Promise<AutoCheckResult>;
  /** Tear down what the driver left behind (the ask's herdr workspace) when the step is left. */
  endDrive: (kind: DriveKind, project: string) => Promise<void>;
  trace: (line: string) => void;
};

async function seedProject(): Promise<string> {
  const existing = (await knownProjects().catch((): string[] => [])).filter(isDisposableProject).sort();
  const last = existing[existing.length - 1];
  if (last) return last;
  const name = disposableProjectName(new Date());
  const devRoot = await invoke<string>("project_dev_root");
  await invoke<string>("project_new", {
    args: { name, target: `${devRoot}/${name}`, source: null, adopt: false, brief: "" },
  });
  return name;
}

let cardsClient: Promise<HubClient> | null = null;
function cardsHub(): Promise<HubClient> {
  cardsClient ??= hubForProject(CARDS_PROJECT).then(url => new HubClient(url));
  return cardsClient;
}

const trace = (line: string) => { void invoke("app_log", { line: `drill-mode ${line}` }).catch(() => {}); };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const KEY_SETTLE_MS = 700;

/** The same deps shape the headless drills take, over the live document. */
const driveDeps: AskDrillDeps = {
  invoke: <T,>(cmd: string, args?: InvokeArgs) => invoke<T>(cmd, args),
  document,
  now: Date.now,
  sleep,
  armDeadline: (ms, expire) => {
    const timer = setTimeout(expire, ms);
    return () => clearTimeout(timer);
  },
};

type PanicsSince = { len: number; text: string };

/** #6317: stage the Workspace lens, focus the terminal pane, post one right-arrow through AppKit,
 *  and read what app-panics.log gained. Resolving at all is the survival proof: a crash here
 *  takes the panel with it. */
async function postKey(project: string): Promise<AutoCheckResult> {
  try {
    await stageWorkspaceLens(project, driveDeps);
  } catch (e) {
    trace(`key staging failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const terminal = document.querySelector<HTMLTextAreaElement>(TERMINAL_INPUT_SELECTOR);
  if (!terminal) return { ok: false, why: "no terminal pane mounted: open the drill project's Workspace lens with a live seat, then press again" };
  terminal.focus();
  await sleep(KEY_SETTLE_MS);
  const mark = await invoke<PanicsSince>("drill_panics_since", { from: 0 });
  const focus = describeFocus(document);
  await invoke("drill_key_post", { target: focus.target });
  await sleep(KEY_SETTLE_MS);
  const after = await invoke<PanicsSince>("drill_panics_since", { from: mark.len });
  const first = after.text.trim().split("\n")[0] ?? "";
  const wrote = first ? `app-panics.log names: ${first.slice(0, 160)}` : "app-panics.log wrote nothing new";
  return { ok: true, why: `right-arrow posted into ${focus.target}; the app is still here; ${wrote}` };
}

let askHeld: { project: string; workspace: string } | null = null;

async function endAsk(): Promise<void> {
  const held = askHeld;
  askHeld = null;
  if (!held) return;
  await invoke("ask_drill_close", { project: held.project, workspace: held.workspace })
    .catch(e => trace(`ask close failed workspace=${held.workspace}: ${e instanceof Error ? e.message : String(e)}`));
}

/** #6533: a haiku session in the stage calls AskUserQuestion (asks.rs ask_drill_start), and
 *  Chat is opened on the stage so the card lands where the operator is looking. The verdict
 *  stays unfilled until the ask-answered probe sees the card turn. */
async function seedAsk(project: string): Promise<AutoCheckResult> {
  await endAsk();
  const marker = `drill-${Date.now()}`;
  const session = await invoke<{ workspace: string; pane: string; agent: string }>("ask_drill_start", { project, marker });
  askHeld = { project, workspace: session.workspace };
  trace(`ask seeded project=${project} agent=${session.agent} workspace=${session.workspace}`);
  try {
    await selectProject(project, driveDeps);
    await selectMode(CHAT_TAB_SELECTOR, driveDeps);
  } catch (e) {
    trace(`ask staging failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: false, why: `ask seeded (agent ${session.agent}); wait for the Drill card in Chat, click Continue, then Check now` };
}

export const drillApi: DrillApi = {
  seedProject,
  moveCard: async (id, status, note) => {
    const client = await cardsHub();
    await client.moveCard(id, status, note);
  },
  screenshot: label => invoke<string>("drill_screenshot", { label }),
  autoCheck: kind => runAutoCheck(kind, document),
  settle: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  drive: (kind, project) => (kind === "post-key" ? postKey(project) : seedAsk(project)),
  endDrive: async kind => { if (kind === "seed-ask") await endAsk(); },
  trace,
};

export { DRILL_PROJECT_PREFIX };
