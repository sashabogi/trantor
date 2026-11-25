// React view of the project shell store: one snapshot per project, plus its actions (#14080).
import { useCallback, useSyncExternalStore } from "react";
import { createShellStore, DEFAULT_SHELL_DEPS, type ProjectShells, type ShellStore } from "./shellStore";
import { createXtermShell } from "./xtermShell";

export const shellStore: ShellStore = createShellStore({ ...DEFAULT_SHELL_DEPS, createSession: createXtermShell });

export function useShells(project: string, store: ShellStore = shellStore): ProjectShells & {
  open: () => void; kill: (sub: number) => void; select: (sub: number) => void; fit: (sub: number) => void;
} {
  const snapshot = useSyncExternalStore(store.subscribe, () => store.get(project));
  const open = useCallback(() => { void store.open(project); }, [store, project]);
  const kill = useCallback((sub: number) => store.kill(project, sub), [store, project]);
  const select = useCallback((sub: number) => store.select(project, sub), [store, project]);
  const fit = useCallback((sub: number) => store.fit(project, sub), [store, project]);
  return { ...snapshot, open, kill, select, fit };
}
