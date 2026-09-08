import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "./app/AppShell";
import { runAskDrill } from "./features/chat/askDrill";
import { parseKeyDrillPayload, runKeyDrill } from "./features/workspace/keyDrill";
import { runHandoffDrill } from "./features/chat/handoffDrill";
import "./styles.css";

// #6094 acceptance drill: the Rust shell emits `ask-drill` when TRANTOR_ASK_DRILL=<project> is
// set, and the drill drives the real Chat path headlessly (see askDrill.ts). Inert otherwise.
void listen<string>("ask-drill", ev => { void runAskDrill(ev.payload); });
// #6317 acceptance drill: `key-drill` fires when TRANTOR_KEY_DRILL=post|throw is set (with the
// TRANTOR_KEY_DRILL_PROJECT to stage in the payload), and the drill has Rust post a real
// right-arrow through AppKit at three focus targets (keyDrill.ts).
void listen<string>("key-drill", ev => { void runKeyDrill(parseKeyDrillPayload(ev.payload)); });
// #6668 acceptance drill: `handoff-drill` fires when TRANTOR_HANDOFF_DRILL=<project> is set, and
// the drill opens that project's Chat on a bare-shell pane and proves no handoff fires.
void listen<string>("handoff-drill", ev => { void runHandoffDrill(ev.payload); });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppShell /></React.StrictMode>
);
