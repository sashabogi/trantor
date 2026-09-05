import React from "react";
import ReactDOM from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "./app/AppShell";
import { runAskDrill } from "./features/chat/askDrill";
import "./styles.css";

// #6094 acceptance drill: the Rust shell emits `ask-drill` when TRANTOR_ASK_DRILL=<project> is
// set, and the drill drives the real Chat path headlessly (see askDrill.ts). Inert otherwise.
void listen<string>("ask-drill", ev => { void runAskDrill(ev.payload); });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppShell /></React.StrictMode>
);
