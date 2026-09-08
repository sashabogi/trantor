// Drill Mode (#6800) — the side-effect seam. Everything DrillMode.tsx does to the world goes
// through this object so the flow test hands in fakes the way OnboardingFlow's deps work:
// the disposable stage (trantor new), the card moves (the trantor hub, where the visual cards
// live — NOT the stage project's hub), the screenshot (a Rust command shelling to screencapture),
// and the app-trace line that lets app-trace.log tell a drill close from a seat's.
import { invoke } from "@tauri-apps/api/core";
import { HubClient, hubForProject, knownProjects } from "../../shared/api/client";
import { DRILL_PROJECT_PREFIX, disposableProjectName, isDisposableProject } from "./drillSteps";
import type { AutoCheckKind, AutoCheckResult } from "./drillSteps";
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

export const drillApi: DrillApi = {
  seedProject,
  moveCard: async (id, status, note) => {
    const client = await cardsHub();
    await client.moveCard(id, status, note);
  },
  screenshot: label => invoke<string>("drill_screenshot", { label }),
  autoCheck: kind => runAutoCheck(kind, document),
  settle: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  trace: line => { void invoke("app_log", { line: `drill-mode ${line}` }).catch(() => {}); },
};

export { DRILL_PROJECT_PREFIX };
