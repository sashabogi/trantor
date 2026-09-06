// The WORKSPACE lens's one bridge to Rust: codex's FROZEN herdr commands (#5366/#5399). The shapes
// below are the contract — if they ever need to change, that is a conversation with the
// architect, not an edit here.
//
// herdr_seats() parses ~/.agent-bus/herdr-windows.txt down to [{project, agent, surface}] (rows
// are TAB-separated `PROJECT\tKIND\tAGENT\tHANDLE`, KIND=="herdr" only, last row per
// (project, agent) wins). The terminal functions attach a client pty to that surface and stream
// raw bytes; there is no pane-read polling path anymore.
import { Channel, invoke, type InvokeArgs } from "@tauri-apps/api/core";

export type HerdrSeat = {
  project: string;
  agent: string;
  surface: string;
  /** "herdr" = a crew seat, "orch" = the operator's own session hosted by `trantor open` */
  kind: string;
};
export type TerminalBytes = number[] | Uint8Array | ArrayBuffer;

/** JSON.parse's `any` flows into HerdrSeat[] without a cast — the same pattern client.ts
 * documents for doctor()/cardCode(). Rust owns validation; a malformed payload throws here. */
export async function herdrSeats(): Promise<HerdrSeat[]> {
  return JSON.parse(await invoke<string>("herdr_seats"));
}

/** The herdr surface running `agent`'s seat on `project`, or null when none exists — null is
 * the caller's cue to keep the stated-placeholder ghost, not to error. */
export async function surfaceFor(project: string, agent: string): Promise<string | null> {
  const seats = await herdrSeats();
  // Last row per (project, agent) already wins Rust-side; take the last match defensively.
  const mine = seats.filter(s => s.project === project && s.agent === agent);
  return mine.length ? (mine[mine.length - 1].surface ?? null) : null;
}

export async function orchestratorOpen(project: string): Promise<string> {
  return invoke<string>("orchestrator_open", { project });
}

/** A restorable orch pane: the project it belongs to, and a stable id for THIS dead session (the
 *  pane handle) — #6476 keys durable dismissals on this pair so a new dead session for the same
 *  project is never confused with one already dismissed. */
export type RestorableSession = { project: string; sessionId: string };

/** #5401 — projects whose orchestrator pane survived while the conversation inside died (the
 *  reboot shape). Queried at app LAUNCH only; `orchestratorOpen` is the resume vehicle. */
export async function orchRestorables(): Promise<RestorableSession[]> {
  return invoke<RestorableSession[]>("orch_restorables");
}

export async function termAttach(target: string, onBytes: (bytes: TerminalBytes) => void): Promise<number> {
  const onBytesChannel = new Channel<TerminalBytes>(onBytes);
  return invoke<number>("term_attach", { target, onBytes: onBytesChannel });
}

/** Writes keystrokes/drops into the pty. Returns how many chunks Rust split the payload into —
 *  the paste-split trace reads it (#5921). */
export async function termWrite(sub: number, data: string): Promise<string> {
  return invoke<string>("term_write", { sub, data });
}

export async function termResize(sub: number, cols: number, rows: number): Promise<void> {
  await invoke("term_resize", { sub, cols, rows });
}

export async function termDetach(sub: number): Promise<void> {
  await invoke("term_detach", { sub });
}

/** Answer a picker (AskUserQuestion, a permission prompt, any TUI choice) the same way the live
 *  terminal does (#6094): `pane_send`'s `agent.prompt` refuses outright while the pane is
 *  blocked — the picker needs raw keystrokes, not a prompt — so this writes `data` through
 *  herdr's `pane.send_text` (the Rust command `ask_answer`), the pane-level primitive underneath
 *  `agent.prompt` with none of its agent-lifecycle gating.
 *
 *  0.3.147's real-path bounce (09-05, EIO "Input/output error"): the FIRST version of this
 *  function opened its own throwaway `term_attach` (spawning a local `herdr agent attach`
 *  subprocess) and wrote into that. `attach` opens a STREAMING watch client — read-only by
 *  design without an explicit takeover, since a second observer must never be able to inject
 *  into a pane someone else is typing in — so the write always failed. `pane.send_text` is a
 *  single fire-and-forget socket call with no client lifecycle to get wrong: verified live
 *  against a throwaway pane, an escape sequence arrived byte-for-byte.
 *
 *  Traced into app-trace.log (the 0.3.147 bounce's own lesson: a click that answered nothing
 *  left no evidence at all beyond a success-only log line) so a future failure still names
 *  itself, even though there is only one step now.
 *
 *  `invokeFn` is the same seam Chat's own `ChatDeps` uses (never a mocked module) — a test
 *  supplies a faithful in-memory `invoke` and asserts on exactly which command name and args
 *  this function called, proving the writable path without touching Tauri's real IPC. */
export async function answerAtPane(
  target: string,
  data: string,
  invokeFn: <T>(cmd: string, args?: InvokeArgs) => Promise<T> = invoke,
): Promise<void> {
  const trace = (line: string) => { void invokeFn("app_log", { line: `ask answer: ${line}` }).catch(() => {}); };
  try {
    const t0 = performance.now();
    await invokeFn("ask_answer", { target, data });
    trace(`sent target=${target} bytes=${data.length} ms=${Math.max(0, Math.round(performance.now() - t0))}`);
  } catch (e) {
    trace(`FAILED target=${target} bytes=${data.length}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

export function terminalBytes(bytes: TerminalBytes): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes);
}

/** The project's orchestrator pane, or null when `trantor open` has not hosted one here. The
 *  agent column arrives already renamed to "orchestrator" by Rust, so surfaceFor() finds it
 *  under that name like any other pane. */
export async function orchestratorOf(project: string): Promise<HerdrSeat | null> {
  const seats = await herdrSeats();
  const mine = seats.filter(s => s.project === project && s.kind === "orch");
  return mine.length ? mine[mine.length - 1] : null;
}
