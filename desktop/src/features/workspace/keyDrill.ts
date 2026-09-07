// #6317's built-app acceptance drill. TRANTOR_KEY_DRILL=post|throw makes Rust emit `key-drill`
// after boot; this focuses nothing, then the terminal pane, then any other textarea, and has Rust
// post a real right-arrow keyDown/keyUp through AppKit's event queue for each (src-tauri/src/
// key_drill.rs). The seat writes this drill but never launches it. The orchestrator builds and
// runs it.
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

const TERMINAL_INPUT_SELECTOR = ".xterm-helper-textarea";
const OTHER_TEXTAREA_SELECTOR = `textarea:not(${TERMINAL_INPUT_SELECTOR})`;
const POLL_MS = 50;
const TERMINAL_WAIT_MS = 20_000;
const SETTLE_MS = 700;

export type KeyDrillDeps = {
  invoke: <T>(cmd: string, args?: InvokeArgs) => Promise<T>;
  document: Document;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_DEPS: KeyDrillDeps = {
  invoke: <T,>(cmd: string, args?: InvokeArgs) => invoke<T>(cmd, args),
  document,
  now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

export type KeyDrillMode = "post" | "throw";
export type FocusDescription = { target: string; editable: boolean };

/** The `key-drill` event payload is the TRANTOR_KEY_DRILL value Rust already validated. */
export function parseKeyDrillMode(raw: string): KeyDrillMode {
  return raw === "throw" ? "throw" : "post";
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

export async function runKeyDrill(mode: KeyDrillMode, deps: KeyDrillDeps = DEFAULT_DEPS): Promise<void> {
  log(deps, `start mode=${mode}`);
  const passes: string[] = [];
  try {
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
