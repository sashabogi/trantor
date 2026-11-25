// Mounted once by ShellV2: registers the shell's commands, runs a command by its chord, and shows
// the Go to file and command pickers.
import { useCallback, useEffect, useState } from "react";
import { CommandPalette } from "../ui/QuickOpen/CommandPalette";
import { QuickOpen } from "../ui/QuickOpen";
import type { Navigate, Screen } from "../routes";
import { getCommands, useRegisterCommands } from "./commands";
import { setOpenIntent } from "./openIntent";
import { shellCommands } from "./shellCommands";
import type { Mode } from "./shellMode";
import { inTerminal, matchesShortcut } from "./shortcuts";

type Overlay = "quick-open" | "commands" | null;

/** Runs the command whose chord this is. Capture phase, so the chord wins over the focused editor. */
function useChords() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inTerminal(e)) return;
      const command = getCommands().find(c => c.shortcut && !c.listOnly && matchesShortcut(e, c.shortcut));
      if (!command || (command.when && !command.when())) return;
      e.preventDefault();
      e.stopPropagation();
      command.run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export function ShortcutLayer({ project, screen, mode, onMode, onNavigate, onSearch }: {
  project: string; screen: Screen; mode: Mode; onMode: (mode: Mode) => void; onNavigate: Navigate; onSearch: () => void;
}) {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const toggle = useCallback((which: Exclude<Overlay, null>) => setOverlay(cur => (cur === which ? null : which)), []);
  useRegisterCommands(shellCommands({
    project, screen, mode, onMode, onNavigate, onSearch,
    onQuickOpen: () => toggle("quick-open"), onPalette: () => toggle("commands"),
  }));
  useChords();
  const close = () => setOverlay(null);
  const openFile = (path: string) => {
    setOverlay(null);
    setOpenIntent(project, { kind: "file", path });
    onNavigate("code", project);
  };
  if (overlay === "quick-open") return <QuickOpen project={project} onOpen={openFile} onClose={close} />;
  if (overlay === "commands") return <CommandPalette onClose={close} />;
  return null;
}
