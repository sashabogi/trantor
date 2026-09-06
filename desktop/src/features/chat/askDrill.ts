// #6533's built-app acceptance drill. TRANTOR_ASK_DRILL=<project> makes Rust emit `ask-drill`
// after boot; this drives the real ModePane and the real herdr/Claude/hook/Chat/answer path.
// The seat writes this drill but never launches it. The orchestrator builds and runs it.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

const CHAT_TAB_SELECTOR = 'button[aria-label="Chat"]';
const FILES_TAB_SELECTOR = 'button[aria-label="Files"]';
const ASK_CARD_SELECTOR = '[data-testid="ask-card"]';
const POLL_MS = 50;
const ASK_TIMEOUT_MS = 90_000;
const SETTLE_TIMEOUT_MS = 60_000;
const DEADLINE_MS = ASK_TIMEOUT_MS + SETTLE_TIMEOUT_MS + 30_000;

type DrillSession = { workspace: string; pane: string; agent: string };
type DrillPayload = { project?: unknown };
type DrillProbe = {
  sessionId: string | null;
  sidecarExists: boolean;
  sidecarTs: number | null;
  transcriptLines: number;
  traceSeen: boolean;
  openEvents: number;
  webviewEventTs: number | null;
  cardMountTs: number | null;
  pickerVisible: boolean;
  buttonsEnabledTs: number | null;
  answerClickedTs: number | null;
  answerResolvedTs: number | null;
  answerRejected: string | null;
  toolResultMatches: boolean;
  paneAdvanced: boolean;
};

export type AskDrillDeps = {
  invoke: <T>(cmd: string, args?: InvokeArgs) => Promise<T>;
  document: Document;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  armDeadline: (ms: number, expire: () => void) => () => void;
};

const DEFAULT_DEPS: AskDrillDeps = {
  invoke: <T,>(cmd: string, args?: InvokeArgs) => invoke<T>(cmd, args),
  document,
  now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  armDeadline: (ms, expire) => {
    const timer = setTimeout(expire, ms);
    return () => clearTimeout(timer);
  },
};

function findProjectRow(doc: Document, project: string): HTMLElement | null {
  for (const row of doc.querySelectorAll<HTMLElement>('div[role="button"]')) {
    if (row.querySelector("span.block.truncate")?.textContent?.trim() === project) return row;
  }
  return null;
}

function askCard(doc: Document, marker: string): HTMLElement | null {
  for (const card of doc.querySelectorAll<HTMLElement>(ASK_CARD_SELECTOR)) {
    if (card.textContent?.includes(marker)) return card;
  }
  return null;
}

async function waitFor<T>(
  read: () => T | null | undefined | false,
  timeoutMs: number,
  deps: AskDrillDeps,
): Promise<T | null> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    const value = read();
    if (value) return value;
    await deps.sleep(POLL_MS);
  }
  return read() || null;
}

async function selectProject(project: string, deps: AskDrillDeps): Promise<void> {
  if (deps.document.querySelector(CHAT_TAB_SELECTOR)) return;
  const row = findProjectRow(deps.document, project);
  if (!row) throw new Error(`no sidebar row for project=${project}`);
  row.click();
  const opened = await waitFor(
    () => deps.document.querySelector<HTMLElement>(CHAT_TAB_SELECTOR),
    5_000,
    deps,
  );
  if (!opened) throw new Error(`project=${project} did not open a mode pane`);
}

async function selectMode(selector: string, deps: AskDrillDeps): Promise<number> {
  const tab = deps.document.querySelector<HTMLButtonElement>(selector);
  if (!tab) throw new Error(`mode tab missing: ${selector}`);
  const clickedAt = deps.now();
  if (tab.getAttribute("data-on") !== "true") tab.click();
  const selected = await waitFor(
    () => deps.document.querySelector(selector)?.getAttribute("data-on") === "true",
    5_000,
    deps,
  );
  if (!selected) throw new Error(`mode tab did not select: ${selector}`);
  return clickedAt;
}

function log(deps: AskDrillDeps, line: string): void {
  void deps.invoke("app_log", { line: `ask-drill ${line}` }).catch(() => {});
}

async function probe(
  project: string,
  marker: string,
  sessionId: string | null,
  deps: AskDrillDeps,
): Promise<DrillProbe> {
  return deps.invoke<DrillProbe>("ask_drill_probe", { project, marker, sessionId });
}

async function waitForProbe(
  read: () => Promise<DrillProbe>,
  accept: (probe: DrillProbe) => boolean,
  timeoutMs: number,
  deps: AskDrillDeps,
): Promise<DrillProbe | null> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    const state = await read();
    if (accept(state)) return state;
    await deps.sleep(POLL_MS);
  }
  return null;
}

function probeSummary(state: DrillProbe): string {
  return `session=${state.sessionId ?? "null"} sidecar=${state.sidecarExists} trace=${state.traceSeen} open=${state.openEvents} webview=${state.webviewEventTs ?? "null"} card=${state.cardMountTs ?? "null"} visible=${state.pickerVisible} answered=${state.toolResultMatches} advanced=${state.paneAdvanced}`;
}

async function runScenarioBody(
  project: string,
  mode: "open" | "cold",
  marker: string,
  deps: AskDrillDeps,
  setStep: (step: string) => void,
): Promise<void> {
  let lastProbeSummary = "";
  const readProbe = async (sessionId: string | null): Promise<DrillProbe> => {
    const state = await probe(project, marker, sessionId, deps);
    const summary = probeSummary(state);
    if (summary !== lastProbeSummary) {
      lastProbeSummary = summary;
      log(deps, `${mode} probe result ${summary}`);
    }
    return state;
  };
  setStep(`${mode}: select mode`);
  if (mode === "open") await selectMode(CHAT_TAB_SELECTOR, deps);
  else await selectMode(FILES_TAB_SELECTOR, deps);
  log(deps, `${mode} setup mode selected`);

  let workspace: string | null = null;
  try {
    log(deps, `${mode} start marker=${marker}`);
    setStep(`${mode}: start interactive session`);
    const cardArrival = mode === "open"
      ? waitFor(() => {
          const card = askCard(deps.document, marker);
          return card ? { card, at: deps.now() } : null;
        }, ASK_TIMEOUT_MS, deps)
      : null;
    const session = await deps.invoke<DrillSession>("ask_drill_start", { project, marker });
    workspace = session.workspace;
    log(deps, `${mode} herdr workspace=${session.workspace} pane=${session.pane} agent=${session.agent}`);

    setStep(`${mode}: wait for sidecar`);
    log(deps, `${mode} probe sidecar begin`);
    const opened = await waitForProbe(
      () => readProbe(null),
      state => state.sidecarExists && Boolean(state.sessionId),
      ASK_TIMEOUT_MS,
      deps,
    );
    if (!opened?.sessionId || opened.sidecarTs === null) {
      throw new Error(`${mode}: sidecar did not appear`);
    }
    log(deps, `${mode} sidecar observed session=${opened.sessionId} ts=${opened.sidecarTs}`);
    if (!opened.traceSeen) log(deps, `${mode} probe ask-received trace begin`);
    const traced = opened.traceSeen ? opened : await waitForProbe(
      () => readProbe(opened.sessionId),
      state => state.traceSeen,
      1_000,
      deps,
    );
    if (!traced) throw new Error(`${mode}: app trace has no ask received line`);
    const baselineLines = opened.transcriptLines;

    let arrival: { card: HTMLElement; at: number } | null;
    let coldTabOpenedAt: number | null = null;
    if (mode === "open") {
      arrival = await cardArrival!;
      if (!arrival) throw new Error("open: DOM card did not arrive");
    } else {
      setStep("cold: select Chat tab");
      log(deps, "cold tab click");
      const tabOpenedAt = await selectMode(CHAT_TAB_SELECTOR, deps);
      coldTabOpenedAt = tabOpenedAt;
      log(deps, `cold tab opened at ${tabOpenedAt}`);
      setStep("cold: wait for replayed card");
      log(deps, "cold replay wait begin");
      arrival = await waitFor(() => {
        const card = askCard(deps.document, marker);
        return card ? { card, at: deps.now() } : null;
      }, 1_500, deps);
      if (!arrival) throw new Error("cold: replayed DOM card did not arrive within 1500ms of opening Chat");
      log(deps, `cold replayed card observed at ${arrival.at}`);
    }

    setStep(`${mode}: read card timing probe`);
    log(deps, `${mode} probe card timing begin`);
    const beforeAnswer = await waitForProbe(
      () => readProbe(opened.sessionId),
      state => state.webviewEventTs !== null && state.cardMountTs !== null,
      1_000,
      deps,
    );
    if (!beforeAnswer?.webviewEventTs || !beforeAnswer.cardMountTs) {
      throw new Error(`${mode}: webview/card timing traces did not land`);
    }
    const hookToWebview = beforeAnswer.webviewEventTs - opened.sidecarTs;
    const webviewToDom = beforeAnswer.cardMountTs - beforeAnswer.webviewEventTs;
    const hookToDom = beforeAnswer.cardMountTs - opened.sidecarTs;
    const coldReplayMs = coldTabOpenedAt === null ? null : beforeAnswer.cardMountTs - coldTabOpenedAt;
    if (mode === "open" && hookToDom > 1_000) {
      throw new Error(`open: DOM card arrived ${hookToDom}ms after hook (hook-webview=${hookToWebview}ms webview-dom=${webviewToDom}ms)`);
    }
    if (coldReplayMs !== null && coldReplayMs > 1_500) {
      throw new Error(`cold: replayed DOM card mounted ${coldReplayMs}ms after tab open`);
    }
    if (beforeAnswer.openEvents !== 1) {
      throw new Error(`${mode}: expected one open event, saw ${beforeAnswer.openEvents}`);
    }
    if (beforeAnswer.transcriptLines !== baselineLines) {
      throw new Error(`${mode}: transcript grew before the DOM card (${baselineLines} -> ${beforeAnswer.transcriptLines})`);
    }
    log(deps, `${mode} card mounted hookTs=${opened.sidecarTs} webviewTs=${beforeAnswer.webviewEventTs} domTs=${beforeAnswer.cardMountTs}`);
    setStep(`${mode}: wait for visible answer buttons`);
    log(deps, `${mode} probe visibility begin`);
    const visible = await waitForProbe(
      () => readProbe(opened.sessionId),
      state => state.pickerVisible && state.buttonsEnabledTs !== null,
      5_000,
      deps,
    );
    if (!visible?.buttonsEnabledTs) throw new Error(`${mode}: answer buttons did not become visible`);
    const option = await waitFor(() => {
      const card = askCard(deps.document, marker);
      return [...(card?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
        .find(button => button.textContent?.includes("Continue") && !button.disabled) ?? null;
    }, 5_000, deps);
    if (!option) throw new Error(`${mode}: session-routed answer button stayed read-only`);
    log(deps, `${mode} buttons enabled at ${visible.buttonsEnabledTs}`);
    setStep(`${mode}: click answer`);
    const clickedAt = deps.now();
    option.click();
    log(deps, `${mode} clicked at ${clickedAt}`);

    setStep(`${mode}: wait for answer settlement`);
    log(deps, `${mode} probe settlement begin`);
    const settled = await waitForProbe(
      () => readProbe(opened.sessionId),
      state => state.openEvents === 1 && !state.sidecarExists && state.pickerVisible &&
        state.answerResolvedTs !== null && state.toolResultMatches && state.paneAdvanced,
      SETTLE_TIMEOUT_MS,
      deps,
    );
    if (!settled) {
      const last = await readProbe(opened.sessionId);
      throw new Error(last.answerRejected ?? `${mode}: answer did not settle sidecar, tool_result, and pane advance`);
    }
    log(deps, `${mode} answer resolved at ${settled.answerResolvedTs}`);
    const closed = await waitFor(() => askCard(deps.document, marker) === null, 1_000, deps);
    if (!closed) throw new Error(`${mode}: closed event left the question card open`);
    log(deps, `${mode} PASS session=${opened.sessionId} hookTs=${opened.sidecarTs} webviewTs=${beforeAnswer.webviewEventTs} domTs=${beforeAnswer.cardMountTs} hook-webview=${hookToWebview}ms webview-dom=${webviewToDom}ms cold-replay=${coldReplayMs === null ? "n/a" : `${coldReplayMs}ms`} open-events=1 picker=visible-before-send sidecar=gone tool_result=matched card=closed pane=advanced`);
  } finally {
    if (workspace) {
      await deps.invoke("ask_drill_close", { project, workspace })
        .catch(error => log(deps, `${mode} cleanup FAILED workspace=${workspace}: ${String(error)}`));
    }
  }
}

async function runScenario(
  project: string,
  mode: "open" | "cold",
  marker: string,
  deps: AskDrillDeps,
): Promise<void> {
  let step = `${mode}: enter`;
  let cancelDeadline = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancelDeadline = deps.armDeadline(DEADLINE_MS, () => {
      const error = new Error(`deadline at step ${step}`);
      log(deps, `FAILED: ${error.message}`);
      reject(error);
    });
  });
  try {
    await Promise.race([
      runScenarioBody(project, mode, marker, deps, next => { step = next; }),
      deadline,
    ]);
  } finally {
    cancelDeadline();
  }
}

export async function runAskDrill(rawPayload: string, deps: AskDrillDeps = DEFAULT_DEPS): Promise<void> {
  // SAFETY: project is normalized to a string below; every other JSON field is ignored.
  const payload = JSON.parse(rawPayload) as DrillPayload;
  const project = String(payload.project ?? "").trim();
  if (!project) {
    log(deps, "FAILED: payload has no project");
    return;
  }
  try {
    await selectProject(project, deps);
    const nonce = `${deps.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    await runScenario(project, "open", `open-${nonce}`, deps);
    await runScenario(project, "cold", `cold-${nonce}`, deps);
    log(deps, "PASS: real AskUserQuestion sidecar/card/answer path passed with Chat open and cold");
  } catch (error) {
    log(deps, `FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}
