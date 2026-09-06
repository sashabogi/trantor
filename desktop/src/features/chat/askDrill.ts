// The #6094 real-path acceptance drill, run in the REAL webview: `TRANTOR_ASK_DRILL=<project>`
// makes the Rust shell emit `ask-drill` after boot (src-tauri/src/lib.rs `run()`), and this mounts
// the REAL Chat component (no mocked deps — the same invoke/listen/orchestratorOf the operator's
// session uses) against that project's live orchestrator pane. It does not click anything and
// does not touch the visible window: the host is off-screen, and it never calls `trantor up`.
//
// Four things get proved, all narrated into app-trace.log via app_log (never asserted only in
// process memory the operator can't see):
//   1. whatever the live transcript's CURRENT ask state is, the real backfill/chat_watch path
//      (Chat's own mount effects — no drill-side shortcut) renders it as a card if one is open;
//   2. a push through the REAL emit mechanism (`ask_drill_fire_status`, 0.3.149 — the SAME
//      channel-to-async-task pattern spawn_status_watcher's background thread uses, the #5993
//      fix that made a raw std::thread's window.emit() actually reach the frontend) reaches
//      Chat's listener and either surfaces a card or fires the #6094 blocked-no-ask trace line.
//      An EARLIER version of this drill used the JS-side `emit()` from `@tauri-apps/api/event`
//      instead — proven (0.3.148 real-path bounce) to exercise a DIFFERENT channel from the real
//      one: a Chat mounted well before the push, on its settled gen-2 watcher, never received a
//      REAL blocked emit, while the JS-side synthetic push always reached it regardless. This
//      version waits a realistic span after mount (matching the ~20s gap the real bounce showed
//      between mount and the live blocked frame) before firing through the real mechanism, so it
//      catches whatever timing-dependent gap the old synthetic push could never see;
//   3. if no ask was open when blocked was pushed, Chat's own retry (FAST_RETRY_MS/WINDOW,
//      SLOW_RETRY_MS/WINDOW — 0.3.145's fix: herdr's blocked frame can land a moment before the
//      CLI finishes writing the tool_use row) keeps re-syncing on its own for
//      FAST_RETRY_WINDOW_MS + SLOW_RETRY_WINDOW_MS — the drill waits past that whole span before
//      concluding nothing arrived, so a real ask written moments after blocked still gets caught;
//   4. (0.3.147's EIO bounce — the click path attached to a read-only watch client) if
//      TRANTOR_ASK_DRILL_WRITE_TARGET names a pane, answerAtPane's real `ask_answer` write goes
//      through the SAME code the ask card's own click uses, against that pane and NEVER the real
//      orchestrator — the operator sets it up themselves (a throwaway `herdr workspace create`
//      pane running `cat -v`) and reads it back to confirm the exact bytes arrived.
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { createElement } from "react";
import { Chat, FAST_RETRY_WINDOW_MS, SLOW_RETRY_WINDOW_MS } from "./Chat";
import { answerAtPane } from "../workspace/herdr";
import { answerKeystrokes } from "./streaming";

/** How long the 0.3.148 real bounce showed elapsing between Chat settling on its gen-2 watcher
 *  and the real blocked frame arriving — the drill waits at least this long before firing
 *  through the real emit mechanism, so it exercises the SAME "listener alive N seconds" shape
 *  the real failure did, not an emit fired within the same tick as mount. */
const SETTLE_BEFORE_REAL_EMIT_MS = 20_000;

function log(line: string): void {
  invoke("app_log", { line: `ask-drill ${line}` }).catch(() => {});
}

/** Off-screen, never visible, never in the tab order — the drill mounts a real Chat instance
 *  without disturbing whatever the operator has open. */
function makeHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.dataset.askDrill = "host";
  Object.assign(host.style, {
    position: "fixed",
    top: "-9999px",
    left: "-9999px",
    width: "480px",
    height: "800px",
    pointerEvents: "none",
  });
  document.body.append(host);
  return host;
}

const ASK_CARD_SELECTOR = '[data-testid="ask-card"]';

function snapshot(host: HTMLDivElement): string {
  const cards = host.querySelectorAll(ASK_CARD_SELECTOR).length;
  const text = (host.textContent ?? "").replace(/\s+/g, " ").trim();
  return `cards=${cards} text="${text.slice(0, 160)}${text.length > 160 ? "…" : ""}"`;
}

/** Poll until either an ask card shows or the deadline passes — never a fixed sleep, since the
 *  real backfill/chat_watch settle time varies with transcript size. */
async function waitFor(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return predicate();
}

/** #6094, 0.3.147 — proves the WRITE path (answerAtPane -> ask_answer -> herdr's pane.send_text)
 *  against a pane the operator controls, never the real orchestrator. Sends the exact byte
 *  sequence answerKeystrokes() builds for picking option 0 of a representative two-option,
 *  single-select question — the same call the ask card's own click makes. The operator reads
 *  the pane back (a `cat -v` pane echoes control bytes visibly, e.g. `^[[B` then `\r`) to
 *  confirm the bytes arrived; this function only proves the CALL succeeded (no exception, no
 *  EIO), not what appeared on screen — it has no read path into the target pane. */
async function runWriteProbe(writeTarget: string): Promise<void> {
  log(`write-probe start target=${writeTarget}`);
  const probeQuestion = {
    header: "drill", question: "probe", multiSelect: false,
    options: [{ label: "a", description: "" }, { label: "b", description: "" }],
  };
  const data = answerKeystrokes(probeQuestion, [0]);
  try {
    await answerAtPane(writeTarget, data);
    log(`write-probe sent target=${writeTarget} bytes=${JSON.stringify(data)} — read the pane back to confirm the bytes arrived`);
  } catch (e) {
    log(`write-probe FAILED target=${writeTarget}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runAskDrill(rawPayload: string): Promise<void> {
  // SAFETY: this drill's own Rust setup (`run()` above) is the only emitter of "ask-drill" and
  // always sends `JSON.stringify({ project, writeTarget })` — the same same-origin trust Chat.tsx
  // extends to Rust's own `orchestrator_chat` envelope.
  const { project, writeTarget } = JSON.parse(rawPayload) as { project: string; writeTarget: string | null };
  log(`start project=${project} writeTarget=${writeTarget ?? "(none)"}`);
  if (writeTarget) {
    await runWriteProbe(writeTarget);
  }
  const host = makeHost();
  const root = createRoot(host);
  try {
    // Real deps (Chat's own DEFAULT_CHAT_DEPS) — the drill drives the exact path the operator's
    // window runs: orchestrator_chat backfill, chat_watch, the "orch-status"/"chat-rows" listeners.
    root.render(createElement(Chat, { project, dock: "pane", onDock: () => {}, onClose: () => {} }));

    const settled = await waitFor(() => host.textContent !== null && host.textContent.length > 0, 10_000);
    log(`mounted, initial render settled=${settled} ${snapshot(host)}`);

    const beforeReal = host.querySelectorAll(ASK_CARD_SELECTOR).length;
    if (beforeReal > 0) {
      log(`REAL open ask already rendered from the live transcript — the backfill/render path works right now: ${snapshot(host)}`);
    } else {
      log(`no ask card from the real backfill alone (transcript may have nothing open) — ${snapshot(host)}`);
    }

    // Let Chat settle on its gen-2 watcher (target null -> a live pane, #5495) the same way a
    // real session does — the 0.3.148 bounce's gap was ~20s between mount and the live blocked
    // frame, and a push fired within the same tick as mount never exercised that gap at all.
    log(`waiting ${SETTLE_BEFORE_REAL_EMIT_MS}ms for the gen-2 watcher to settle before firing the real emit path`);
    await new Promise(r => setTimeout(r, SETTLE_BEFORE_REAL_EMIT_MS));

    // The REAL emit path (#6094, 0.3.149): the same channel-to-async-task mechanism
    // spawn_status_watcher's background thread uses, invoked on the drill's own schedule so it
    // can fire well after mount instead of within the same tick.
    log(`firing the real emit path: project=${project} status=blocked`);
    await invoke("ask_drill_fire_status", { project, status: "blocked" });

    // Wait past Chat's OWN retry span (#6094, 0.3.145): a real ask can be written a moment after
    // herdr reports blocked, and Chat keeps re-syncing on its own for this whole window before
    // giving up — cutting the wait shorter than this would call a retry-in-progress a failure.
    const retryWindowMs = FAST_RETRY_WINDOW_MS + SLOW_RETRY_WINDOW_MS + 1_000;
    const reacted = await waitFor(() => host.querySelectorAll(ASK_CARD_SELECTOR).length > beforeReal, retryWindowMs);
    log(`after the real blocked push (waited up to ${retryWindowMs}ms for the retry to run its course): card-count-increased=${reacted} ${snapshot(host)}`);

    if (!reacted && beforeReal === 0) {
      log("no ask card appeared after the real blocked push, even past the retry window — if the live transcript truly has no open ask, this is CORRECT and the #6094 blocked-no-ask trace line above (search for 'chat blocked with no open ask') should have fired, followed by 'chat blocked-no-ask retry N' lines; their absence means Chat never reacted to the real push at all — check whether 'chat status ...: push=blocked' ever appears after the 'ask-drill: fired the real emit path' line above");
    }
    log("done");
  } catch (e) {
    log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    root.unmount();
    host.remove();
  }
}
