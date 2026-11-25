// Project shells held outside React so they outlive the panel, its tabs and the Code lens (#14080).
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const SHELL_EXIT_EVENT = "term-shell-exit";
export const SHELL_LABEL = "zsh";

/** One xterm behind a narrow surface, so the store and its tests never touch xterm itself. */
export type ShellSession = {
  write(bytes: Uint8Array): void;
  onData(cb: (data: string) => void): { dispose(): void };
  attach(parent: HTMLElement): void;
  show(visible: boolean): void;
  fit(): void;
  focus(): void;
  readonly cols: number;
  readonly rows: number;
  dispose(): void;
};

export type ShellDeps = {
  createSession(): ShellSession;
  open(project: string, onBytes: (bytes: Uint8Array) => void): Promise<number>;
  write(sub: number, data: string): Promise<string>;
  resize(sub: number, cols: number, rows: number): Promise<void>;
  detach(sub: number): Promise<void>;
  onExit(handler: (sub: number) => void): Promise<() => void>;
};

export type Shell = { sub: number; name: string; session: ShellSession };
export type ProjectShells = {
  shells: Shell[];
  active: number | null;
  starting: boolean;
  /** Set once the list was emptied on purpose or by an exit, so the panel does not respawn one. */
  idle: boolean;
  error: string | null;
};

const EMPTY: ProjectShells = { shells: [], active: null, starting: false, idle: false, error: null };

export const DEFAULT_SHELL_DEPS: Omit<ShellDeps, "createSession"> = {
  open: (project, onBytes) => invoke<number>("term_shell_open", { project, onBytes: new Channel<number[] | Uint8Array>(bytes => onBytes(Uint8Array.from(bytes))) }),
  write: (sub, data) => invoke<string>("term_write", { sub, data }),
  resize: (sub, cols, rows) => invoke<void>("term_resize", { sub, cols, rows }),
  detach: (sub) => invoke<void>("term_detach", { sub }),
  onExit: async handler => listen<number>(SHELL_EXIT_EVENT, event => handler(event.payload)),
};

export type ShellStore = ReturnType<typeof createShellStore>;

export function createShellStore(deps: ShellDeps) {
  const projects = new Map<string, ProjectShells>();
  const seqs = new Map<string, number>();
  const listeners = new Set<() => void>();
  let exitWatch: Promise<() => void> | null = null;

  const get = (project: string): ProjectShells => projects.get(project) ?? EMPTY;
  const set = (project: string, next: ProjectShells) => {
    projects.set(project, next);
    listeners.forEach(listener => listener());
  };
  const patch = (project: string, change: Partial<ProjectShells>) => set(project, { ...get(project), ...change });

  const drop = (project: string, sub: number) => {
    const current = get(project);
    const at = current.shells.findIndex(shell => shell.sub === sub);
    if (at < 0) return;
    const shells = current.shells.filter(shell => shell.sub !== sub);
    const neighbour = shells[Math.min(at, shells.length - 1)]?.sub ?? null;
    const active = current.active === sub ? neighbour : current.active;
    current.shells[at]?.session.dispose();
    set(project, { ...current, shells, active, idle: current.idle || shells.length === 0 });
  };

  const watchExits = () => {
    exitWatch ??= deps.onExit(sub => {
      for (const [project, state] of projects) {
        if (!state.shells.some(shell => shell.sub === sub)) continue;
        drop(project, sub);
        void deps.detach(sub).catch(() => undefined);
      }
    });
    exitWatch.catch(() => { exitWatch = null; });
  };

  const open = async (project: string) => {
    if (get(project).starting) return;
    watchExits();
    patch(project, { starting: true, idle: false, error: null });
    const session = deps.createSession();
    try {
      const sub = await deps.open(project, bytes => session.write(bytes));
      const seq = (seqs.get(project) ?? 0) + 1;
      seqs.set(project, seq);
      session.onData(data => { void deps.write(sub, data).catch(() => undefined); });
      const current = get(project);
      set(project, { ...current, shells: [...current.shells, { sub, name: `${SHELL_LABEL} ${seq}`, session }], active: sub, starting: false });
    } catch (err) {
      session.dispose();
      patch(project, { starting: false, idle: true, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const kill = (project: string, sub: number) => {
    if (!get(project).shells.some(shell => shell.sub === sub)) return;
    drop(project, sub);
    void deps.detach(sub).catch(() => undefined);
  };

  const select = (project: string, sub: number) => {
    if (get(project).shells.some(shell => shell.sub === sub)) patch(project, { active: sub });
  };

  const fit = (project: string, sub: number) => {
    const shell = get(project).shells.find(item => item.sub === sub);
    if (!shell) return;
    try { shell.session.fit(); } catch { /* not laid out yet; the next resize fits again */ }
    if (shell.session.cols > 0 && shell.session.rows > 0) void deps.resize(sub, shell.session.cols, shell.session.rows).catch(() => undefined);
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  return { get, subscribe, open, kill, select, fit };
}
