// The xterm behind one project shell: same packages, theme and fit addon as the seat pane (#14080).
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { appChordFromTerminal, isTerminalClear } from "../../shell/shortcuts";
import type { ShellSession } from "./shellStore";

const THEME = {
  background: "#101013",
  foreground: "#ececf0",
  cursor: "#ececf0",
  selectionBackground: "rgba(20, 184, 166, 0.25)",
};

export function createXtermShell(): ShellSession {
  const el = document.createElement("div");
  el.style.height = "100%";
  el.style.width = "100%";
  const term = new Terminal({
    convertEol: true,
    fontSize: 12,
    fontFamily: '"SF Mono", ui-monospace, "Menlo", monospace',
    theme: THEME,
    scrollback: 5000,
    cursorBlink: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // #14268: Cmd chords belong to the app, so xterm leaves them alone; Ctrl keys still reach the shell.
  term.attachCustomKeyEventHandler(e => {
    if (isTerminalClear(e)) { term.clear(); return false; }
    return !appChordFromTerminal(e);
  });
  term.open(el);
  return {
    write: bytes => term.write(bytes),
    onData: cb => term.onData(cb),
    attach: parent => { if (el.parentElement !== parent) parent.appendChild(el); },
    show: visible => { el.style.display = visible ? "block" : "none"; },
    fit: () => fit.fit(),
    focus: () => term.focus(),
    onTitle: cb => term.onTitleChange(cb),
    selection: () => term.getSelection(),
    paste: text => term.paste(text),
    clear: () => term.clear(),
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    // Teardown must not throw: it runs from a list update inside a React render path.
    dispose() {
      try { el.remove(); } catch { /* already detached */ }
      try { fit.dispose(); } catch { /* addon may be detached already */ }
      try { term.dispose(); } catch { /* nothing further to do */ }
    },
  };
}
