// Project shells held outside React so they outlive the panel, its tabs and the Code lens (#14080).
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const SHELL_EXIT_EVENT = "term-shell-exit";
export const SHELL_LABEL = "zsh";
/** The exit event from shell_terminal.rs; the code is null when the pty could not report one. */
export type ShellExit = { sub: number; code: number | null };

/** One xterm behind a narrow surface, so the store and its tests never touch xterm itself. */
export type ShellSession = {
  write(bytes: Uint8Array): void;
  onData(cb: (data: string) => void): { dispose(): void };
  attach(parent: HTMLElement): void;
  show(visible: boolean): void;
  fit(): void;
  focus(): void;
  /** The pty's own title (xterm onTitleChange): the folder or the running command. */
  onTitle(cb: (title: string) => void): { dispose(): void };
  /** The selected text, or an empty string. */
  selection(): string;
  paste(text: string): void;
  clear(): void;
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
  onExit(handler: (sub: number, code: number | null) => void): Promise<() => void>;
};

/** `name` is what the list shows: the pty title when it reports one, else the "zsh N" fallback. */
export type Shell = { sub: number; name: string; fallback: string; session: ShellSession; exited: { code: number | null } | null };

/** "me@host:~/code/app" names the folder, "~" stays "~", any other title is the running command. */
export function titleName(title: string): string {
  const text = title.trim();
  const path = /^[^@\s]+@[^:\s]+:(.+)$/.exec(text)?.[1] ?? (/^[~/]/.test(text) ? text : null);
  if (path === null) return text;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed === "~" ? "~" : trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}
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
  onExit: async handler => listen<ShellExit>(SHELL_EXIT_EVENT, event => handler(event.payload.sub, event.payload.code)),
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
    // #14268: a shell that ends by itself stays in the list with its exit code and a Restart, not a dead prompt.
    exitWatch ??= deps.onExit((sub, code) => {
      for (const [project, state] of projects) {
        if (!state.shells.some(shell => shell.sub === sub)) continue;
        set(project, { ...state, shells: state.shells.map(shell => shell.sub === sub ? { ...shell, exited: { code } } : shell) });
        void deps.detach(sub).catch(() => undefined);
      }
    });
    exitWatch.catch(() => { exitWatch = null; });
  };

  const spawn = async (project: string) => {
    const session = deps.createSession();
    try {
      const sub = await deps.open(project, bytes => session.write(bytes));
      session.onData(data => { void deps.write(sub, data).catch(() => undefined); });
      session.onTitle(title => {
        const name = titleName(title);
        const current = get(project);
        if (!name || !current.shells.some(shell => shell.sub === sub)) return;
        set(project, { ...current, shells: current.shells.map(shell => shell.sub === sub ? { ...shell, name } : shell) });
      });
      return { sub, session };
    } catch (err) {
      session.dispose();
      throw err;
    }
  };

  const open = async (project: string) => {
    if (get(project).starting) return;
    watchExits();
    patch(project, { starting: true, idle: false, error: null });
    try {
      const { sub, session } = await spawn(project);
      const seq = (seqs.get(project) ?? 0) + 1;
      seqs.set(project, seq);
      const fallback = `${SHELL_LABEL} ${seq}`;
      const current = get(project);
      set(project, { ...current, shells: [...current.shells, { sub, name: fallback, fallback, session, exited: null }], active: sub, starting: false });
    } catch (err) {
      patch(project, { starting: false, idle: true, error: err instanceof Error ? err.message : String(err) });
    }
  };

  /** Replaces an exited shell with a fresh one in the same place and under the same name. */
  const restart = async (project: string, sub: number) => {
    if (!get(project).shells.some(shell => shell.sub === sub && shell.exited)) return;
    try {
      const fresh = await spawn(project);
      const current = get(project);
      const old = current.shells.find(shell => shell.sub === sub);
      if (!old) { fresh.session.dispose(); void deps.detach(fresh.sub).catch(() => undefined); return; }
      old.session.dispose();
      set(project, {
        ...current, error: null, active: current.active === sub ? fresh.sub : current.active,
        shells: current.shells.map(shell => shell.sub === sub ? { sub: fresh.sub, name: old.fallback, fallback: old.fallback, session: fresh.session, exited: null } : shell),
      });
    } catch (err) {
      patch(project, { error: err instanceof Error ? err.message : String(err) });
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

  return { get, subscribe, open, restart, kill, select, fit };
}
