import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "./app/AppShell";
import { runAskDrill } from "./features/chat/askDrill";
import { parseKeyDrillMode, runKeyDrill } from "./features/workspace/keyDrill";
import "./styles.css";

// #6094 acceptance drill: the Rust shell emits `ask-drill` when TRANTOR_ASK_DRILL=<project> is
// set, and the drill drives the real Chat path headlessly (see askDrill.ts). Inert otherwise.
void listen<string>("ask-drill", ev => { void runAskDrill(ev.payload); });
// #6317 acceptance drill: `key-drill` fires when TRANTOR_KEY_DRILL=post|throw is set, and the
// drill has Rust post a real right-arrow through AppKit at three focus targets (keyDrill.ts).
void listen<string>("key-drill", ev => { void runKeyDrill(parseKeyDrillMode(ev.payload)); });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppShell /></React.StrictMode>
);
