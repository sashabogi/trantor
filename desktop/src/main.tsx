import React from "react";
import ReactDOM from "react-dom/client";
import { AppShell } from "./app/AppShell";
import { listen } from "@tauri-apps/api/event";
import { runLspDrill } from "./features/code/lspDrill";
import "./styles.css";

// #5857 acceptance drill: the Rust shell emits `lsp-drill` when TRANTOR_LSP_DRILL=<project> is
// set, and the drill drives the real LSP path headlessly (see lspDrill.ts). Inert otherwise.
void listen<string>("lsp-drill", ev => { void runLspDrill(ev.payload); });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppShell /></React.StrictMode>
);
