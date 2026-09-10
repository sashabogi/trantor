// #6317's built-app acceptance drill. TRANTOR_KEY_DRILL=post|throw makes Rust emit `key-drill` after
// boot; this focuses nothing, then the terminal pane, then any other textarea, and has Rust post a
// real right-arrow through AppKit's queue for each (key_drill.rs). TRANTOR_KEY_DRILL_PROJECT names
// the project to open first so a terminal pane is in the DOM. The orchestrator builds and runs it.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { selectProject, type AskDrillDeps } from "../chat/askDrill";

export const TERMINAL_INPUT_SELECTOR = ".xterm-helper-textarea";
const OTHER_TEXTAREA_SELECTOR = `textarea:not(${TERMINAL_INPUT_SELECTOR})`;
/** The ProjectHeader lens segment carries no aria-label; its button reads the lens name. */
const WORKSPACE_LENS_TEXT = "Workspace";
const POLL_MS = 50;
const TERMINAL_WAIT_MS = 20_000;
const SETTLE_MS = 700;

/** The same shape askDrill takes, so selectProject is shared rather than copied. */
export type KeyDrillDeps = AskDrillDeps;

const DEFAULT_DEPS: KeyDrillDeps = {
  invoke: <T,>(cmd: string, args?: InvokeArgs) => invoke<T>(cmd, args),
  document,
  now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  armDeadline: (ms, expire) => {
    const timer = setTimeout(expire, ms);
    return () => clearTimeout(timer);
  },
};

export type KeyDrillMode = "post" | "throw";
export type KeyDrillPayload = { mode: KeyDrillMode; project: string | null };
export type FocusDescription = { target: string; editable: boolean };

/** The mode Rust already validated; anything that is not "throw" is a post run. */
export function parseKeyDrillMode(raw: string): KeyDrillMode {
  return raw === "throw" ? "throw" : "post";
}

/** The `key-drill` payload: `{"mode","project"}` JSON from key_drill::payload, or the bare mode
 *  string the 0.3.159 shell sent. A blank project is no project. */
export function parseKeyDrillPayload(raw: string): KeyDrillPayload {
  try {
    // SAFETY: key_drill::payload writes {"mode","project"}; both are normalized to strings below
    // and every other field is ignored. A JSON null falls to an empty object.
    const payload = (JSON.parse(raw) ?? {}) as { mode?: unknown; project?: unknown };
    const project = String(payload.project ?? "").trim();
    return { mode: parseKeyDrillMode(String(payload.mode ?? "")), project: project || null };
  } catch {
    // not JSON: the bare mode string the 0.3.159 shell sent
    return { mode: parseKeyDrillMode(raw.trim()), project: null };
  }
}

/** What holds keyboard focus, and whether WebKit keeps a text input context (IME) for it. */
export function describeFocus(doc: Document): FocusDescription {
  const el = doc.activeElement;
  if (!(el instanceof HTMLElement) || el === doc.body) return { target: "body", editable: false };
  const tag = el.tagName.toLowerCase();
  const editable = tag === "textarea" || tag === "input" || el.isContentEditable === true;
  const first = el.classList.item(0);
  const cls = first ? `.${first}` : "";
  return { target: `${tag}${cls}`, editable };
}

/** The lens button whose label is the given text, or null when no project header is up. */
export function findLensButton(doc: Document, text: string): HTMLButtonElement | null {
  for (const button of doc.querySelectorAll<HTMLButtonElement>("button")) {
    if (button.textContent?.trim() === text) return button;
  }
  return null;
}

async function waitFor<T>(
  read: () => T | null | undefined | false,
  timeoutMs: number,
  deps: KeyDrillDeps,
): Promise<T | null> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    const value = read();
    if (value) return value;
    await deps.sleep(POLL_MS);
  }
  return read() || null;
}

function log(deps: KeyDrillDeps, line: string): void {
  void deps.invoke("app_log", { line: `key-drill ${line}` }).catch(() => {});
}

/** Open the project from the sidebar and land on its Workspace lens, where the first live pane
 *  target is selected on mount and its terminal renders. Throws when a step has nothing to click.
 *  Drill Mode's key step (#6800, drillApi.ts) stages the same way before it posts. */
export async function stageWorkspaceLens(project: string, deps: KeyDrillDeps): Promise<void> {
  await selectProject(project, deps);
  const lens = await waitFor(() => findLensButton(deps.document, WORKSPACE_LENS_TEXT), 5_000, deps);
  if (!lens) throw new Error(`project=${project} shows no ${WORKSPACE_LENS_TEXT} lens button`);
  if (lens.getAttribute("data-on") !== "true") lens.click();
  await deps.sleep(SETTLE_MS);
  log(deps, `staged project=${project} lens=workspace`);
}

async function postPass(pass: number, deps: KeyDrillDeps): Promise<FocusDescription> {
  const focus = describeFocus(deps.document);
  log(deps, `pass=${pass} focus=${focus.target} editable=${focus.editable}`);
  await deps.invoke("key_drill_post", { pass, target: focus.target, editable: focus.editable });
  await deps.sleep(SETTLE_MS);
  return focus;
}

async function focusAndPost(
  pass: number,
  el: HTMLElement | null,
  missing: string,
  deps: KeyDrillDeps,
): Promise<string> {
  if (!el) {
    log(deps, `pass=${pass} skipped: ${missing}`);
    return `${pass}:skipped`;
  }
  el.focus();
  await deps.sleep(SETTLE_MS);
  return `${pass}:${(await postPass(pass, deps)).target}`;
}

export async function runKeyDrill(payload: KeyDrillPayload, deps: KeyDrillDeps = DEFAULT_DEPS): Promise<void> {
  const { mode, project } = payload;
  log(deps, `start mode=${mode} project=${project ?? "-"}`);
  const passes: string[] = [];
  try {
    if (project) {
      // A staging failure is reported, not fatal: the passes still run and pass 2 says what it
      // could not find, so the trace names the gap instead of hiding the whole run behind it.
      try {
        await stageWorkspaceLens(project, deps);
      } catch (err) {
        log(deps, `staging failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Pass 1: nothing focused. WebKit holds no text input context; the key goes to the page.
    const active = deps.document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    passes.push(`1:${(await postPass(1, deps)).target}`);
    // Pass 2: the terminal pane's xterm textarea, the element under the operator's 09-07 right
    // arrow. An editable element, so WebKit has an active NSTextInputContext (the IME path).
    const terminal = await waitFor(
      () => deps.document.querySelector<HTMLTextAreaElement>(TERMINAL_INPUT_SELECTOR),
      TERMINAL_WAIT_MS,
      deps,
    );
    passes.push(await focusAndPost(2, terminal, "no terminal pane mounted", deps));
    // Pass 3: any other textarea (the composer took the 09-03 Up arrow).
    const other = deps.document.querySelector<HTMLTextAreaElement>(OTHER_TEXTAREA_SELECTOR);
    passes.push(await focusAndPost(3, other, "no other textarea", deps));
    await deps.sleep(SETTLE_MS);
    await deps.invoke("key_drill_finish", { summary: `mode=${mode} ${passes.join(" ")}` });
  } catch (err) {
    log(deps, `ERROR ${String(err)}`);
  }
}
