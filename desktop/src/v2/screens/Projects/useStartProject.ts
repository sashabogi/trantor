// The 2.0 "Start a project" flow's state: the sheet, the create-then-select hand-off, and ⌘N
// (#13984). It wraps the classic GenesisSheet through the sheet's own deps seam.
import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { DEFAULT_GENESIS_DEPS, type GenesisSheetDeps } from "../../../features/genesis/GenesisSheet";
import type { Navigate } from "../../routes";
import { listenTauriWake, useWakeStatus, type ListenWake } from "./useWakeStatus";

export type StartProjectDeps = {
  genesis?: Partial<GenesisSheetDeps>;
  /** The wake-progress channel; default is the Tauri event. */
  listenWake?: ListenWake;
};

/** ⌘N belongs to the shell, never to an input or the terminal: typing keeps every key. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".xterm") || target.closest("input, textarea, select")) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

export function useStartProject(opts: { addProject: (p: string) => void; onNavigate: Navigate; deps?: StartProjectDeps }) {
  const { addProject, onNavigate } = opts;
  const base = opts.deps?.genesis?.invoke ?? DEFAULT_GENESIS_DEPS.invoke;
  const listenDrops = opts.deps?.genesis?.listenDrops ?? DEFAULT_GENESIS_DEPS.listenDrops;
  const status = useWakeStatus(base, opts.deps?.listenWake ?? listenTauriWake);
  const { begin, track } = status;
  const [devRoot, setDevRoot] = useState<string | null>(null);
  const [planHint, setPlanHint] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // The sheet fires project_wake detached; this wrapper is how the shell sees its answer.
  const deps = useMemo<GenesisSheetDeps>(() => ({
    listenDrops,
    invoke: <T,>(cmd: string, args?: InvokeArgs): Promise<T> => {
      if (cmd === "project_new") {
        setCreating(true);
        return base<T>(cmd, args).finally(() => setCreating(false));
      }
      if (cmd === "project_wake") {
        // SAFETY: GenesisSheet sends {project, kickoff}; only the project name is read here.
        const project = String((args as { project?: string } | undefined)?.project ?? "");
        begin(project);
        // SAFETY: project_wake answers with a string; track passes that answer through untouched.
        return track(project, base<string>(cmd, args)) as Promise<T>;
      }
      return base<T>(cmd, args);
    },
  }), [base, listenDrops, begin, track]);

  const startProject = useCallback(() => {
    void base<string>("project_dev_root").then(setDevRoot, () => setDevRoot(""));
  }, [base]);
  const close = useCallback(() => { if (!creating) setDevRoot(null); }, [creating]);
  const created = useCallback((project: string) => {
    setDevRoot(null);
    setPlanHint(project);
    onNavigate("workspace", project);
  }, [onNavigate]);

  const rootProps = {
    tabIndex: -1,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== "n") return;
      if (e.defaultPrevented || devRoot !== null || isEditableTarget(e.target)) return;
      e.preventDefault();
      startProject();
    },
  };
  return {
    open: devRoot !== null, devRoot: devRoot ?? "", deps, wakes: status.wakes, wakeStarts: status.wakeStarts,
    retry: status.retry, dismissWake: status.dismiss, planHint, dismissHint: () => setPlanHint(null),
    startProject, close, rootProps, onMade: addProject, onCreated: created,
  };
}
