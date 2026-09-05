// The #6094 real-path acceptance drill, run in the REAL webview: `TRANTOR_ASK_DRILL=<project>`
// makes the Rust shell emit `ask-drill` after boot (src-tauri/src/lib.rs `run()`), and this mounts
// the REAL Chat component (no mocked deps — the same invoke/listen/orchestratorOf the operator's
// session uses) against that project's live orchestrator pane. It does not click anything and
// does not touch the visible window: the host is off-screen, and it never calls `trantor up`.
//
// Two things get proved, both narrated into app-trace.log via app_log (never asserted only in
// process memory the operator can't see):
//   1. whatever the live transcript's CURRENT ask state is, the real backfill/chat_watch path
//      (Chat's own mount effects — no drill-side shortcut) renders it as a card if one is open;
//   2. a synthetic "orch-status" push (status=blocked, the same string-encoded shape Chat's own
//      listener parses — proven by Chat.test.tsx's mocks, which fire this event this exact way)
//      reaches Chat's listener and either surfaces a card or fires the #6094 blocked-no-ask
//      trace line — so THIS drill's own app-trace output proves whether that trace line is live
//      in the built app, not just in vitest.
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { createElement } from "react";
import { Chat } from "./Chat";

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

export async function runAskDrill(project: string): Promise<void> {
  log(`start project=${project}`);
  const host = makeHost();
  const root = createRoot(host);
  try {
    // Real deps (Chat's own DEFAULT_CHAT_DEPS) — the drill drives the exact path the operator's
    // window runs: orchestrator_chat backfill, chat_watch, the "orch-status"/"chat-rows" listeners.
    root.render(createElement(Chat, { project, dock: "pane", onDock: () => {}, onClose: () => {} }));

    const settled = await waitFor(() => host.textContent !== null && host.textContent.length > 0, 10_000);
    log(`mounted, initial render settled=${settled} ${snapshot(host)}`);

    const beforeSynthetic = host.querySelectorAll(ASK_CARD_SELECTOR).length;
    if (beforeSynthetic > 0) {
      log(`REAL open ask already rendered from the live transcript — the backfill/render path works right now: ${snapshot(host)}`);
    } else {
      log(`no ask card from the real backfill alone (transcript may have nothing open) — ${snapshot(host)}`);
    }

    // The synthetic push: exactly the string-encoded shape Chat.test.tsx's mocks fire this event
    // with (proven to be what Chat's listener parses) — payload is the STRING itself, so however
    // Tauri's own emit() serializes a plain object argument cannot change what a STRING argument
    // survives as: a string round-trips through JSON encode/decode identically.
    const payload = JSON.stringify({ project, pane: "ask-drill", status: "blocked" });
    log(`emitting synthetic orch-status: ${payload}`);
    await emit("orch-status", payload);

    const reacted = await waitFor(() => host.querySelectorAll(ASK_CARD_SELECTOR).length > beforeSynthetic, 5_000);
    log(`after synthetic blocked push: card-count-increased=${reacted} ${snapshot(host)}`);

    if (!reacted && beforeSynthetic === 0) {
      log("no ask card appeared after the synthetic blocked push — if the live transcript truly has no open ask, this is CORRECT and the #6094 blocked-no-ask trace line above (search for 'chat blocked with no open ask') should have fired; its absence means Chat never reacted to the push at all");
    }
    log("done");
  } catch (e) {
    log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    root.unmount();
    host.remove();
  }
}
