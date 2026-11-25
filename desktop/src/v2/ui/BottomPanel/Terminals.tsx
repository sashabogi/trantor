// The Terminal tab: the active project shell on the left, a list of shells on the right (#14080).
import { useEffect, useRef, useState } from "react";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import { MenuItem, Popover } from "../../shell/Popover";
import { Button } from "../Button";
import type { ShellStore } from "./shellStore";
import { useShells } from "./useShells";

export function Terminals({ project, store }: { project: string; store?: ShellStore }) {
  const shells = useShells(project, store);
  const host = useRef<HTMLDivElement | null>(null);
  // The keyboard goes to a terminal only when the user picked or made one, never just because the screen opened.
  const wantFocus = useRef(false);
  const { open, fit } = shells;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const current = shells.shells.find(shell => shell.sub === shells.active) ?? null;
  const closeMenu = () => setMenu(null);
  // #14268: a click anywhere in the terminal area focuses the shell, as in VS Code.
  const focusActive = () => { if (current && !current.exited) current.session.focus(); };
  const copy = () => {
    const text = current?.session.selection() ?? "";
    if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
    closeMenu();
  };
  const paste = () => {
    const session = current?.session;
    closeMenu();
    if (session && !current?.exited) void navigator.clipboard?.readText().then(text => { if (text) session.paste(text); }).catch(() => undefined);
  };
  const clear = () => { current?.session.clear(); closeMenu(); focusActive(); };
  const openNew = () => { wantFocus.current = true; open(); };
  const pick = (sub: number) => { wantFocus.current = true; shells.select(sub); };

  useEffect(() => {
    if (!shells.shells.length && !shells.starting && !shells.idle) open();
  }, [project, shells.shells.length, shells.starting, shells.idle, open]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    for (const shell of shells.shells) {
      shell.session.attach(el);
      shell.session.show(shell.sub === shells.active);
    }
    const active = shells.shells.find(shell => shell.sub === shells.active);
    if (!active) return;
    fit(active.sub);
    if (wantFocus.current) { wantFocus.current = false; active.session.focus(); }
  }, [shells.shells, shells.active, fit]);

  useEffect(() => {
    const el = host.current;
    if (!el || shells.active === null) return;
    const active = shells.active;
    const watcher = new ResizeObserver(() => fit(active));
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [shells.active, fit]);

  // Leaving the tab keeps every shell alive in the store; only its element leaves the DOM.
  useEffect(() => () => { host.current?.replaceChildren(); }, []);

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1 bg-[var(--v2-panel)]">
        <div ref={host} data-testid="terminal-host" onClick={focusActive}
          onContextMenu={event => {
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            setMenu({ x: event.clientX - box.left, y: event.clientY - box.top });
          }}
          className="absolute inset-0 px-2 py-1" />
        {menu && (
          <div className="absolute h-0 w-0" style={{ left: menu.x, top: menu.y - 6 }}>
            <Popover open onClose={closeMenu} label="Terminal actions">
              <MenuItem onSelect={copy}>Copy</MenuItem>
              <MenuItem onSelect={paste}>Paste</MenuItem>
              <MenuItem onSelect={clear}>Clear</MenuItem>
            </Popover>
          </div>
        )}
        {current?.exited && (
          <div role="status" className="absolute inset-x-0 bottom-0 flex items-center gap-3 border-t border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-3 py-1.5 text-v2-body text-[var(--v2-text-2)]">
            <span>{current.exited.code === null ? "Process exited" : `Process exited with code ${current.exited.code}`}</span>
            <Button variant="ghost" icon={<RotateCw size={12} aria-hidden />} onClick={() => { wantFocus.current = true; shells.restart(current.sub); }}>Restart</Button>
          </div>
        )}
        {!shells.shells.length && (
          <Empty starting={shells.starting} error={shells.error} onNew={openNew} />
        )}
      </div>
      <aside aria-label="Terminals" className="flex w-[180px] shrink-0 flex-col border-l border-[var(--v2-edge)] bg-[var(--v2-panel)]">
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--v2-edge)] pl-2.5 pr-1">
          <span className="text-v2-small text-[var(--v2-muted)]">Terminals</span>
          <button type="button" aria-label="New terminal" title="New terminal" onClick={openNew}
            className="v2-hover inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--v2-muted)]">
            <Plus size={14} aria-hidden />
          </button>
        </div>
        <ul className="min-h-0 flex-1 overflow-auto py-1">
          {shells.shells.map(shell => (
            <li key={shell.sub} className={`group flex items-center pr-1 ${shell.sub === shells.active ? "bg-[var(--v2-track)]" : ""}`}>
              <button type="button" aria-current={shell.sub === shells.active} onClick={() => pick(shell.sub)}
                className={`v2-hover min-w-0 flex-1 truncate px-2.5 py-1 text-left text-v2-body ${shell.sub === shells.active ? "text-[var(--v2-text)]" : "text-[var(--v2-muted)]"}`}>
                {shell.name}
              </button>
              <button type="button" aria-label={`Kill terminal ${shell.name}`} title={`Kill terminal ${shell.name}`}
                onClick={() => shells.kill(shell.sub)}
                className="v2-hover inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--v2-muted)]">
                <Trash2 size={13} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

function Empty({ starting, error, onNew }: { starting: boolean; error: string | null; onNew: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--v2-panel)] text-v2-body text-[var(--v2-muted)]">
      {error && <p role="alert" className="max-w-[360px] text-center">{error}</p>}
      {starting ? <p>Starting a terminal</p> : (
        <button type="button" onClick={onNew}
          className="v2-hover inline-flex items-center gap-1.5 rounded-md border border-[var(--v2-edge)] px-2.5 py-1 text-[var(--v2-text)]">
          <Plus size={13} aria-hidden />New terminal
        </button>
      )}
    </div>
  );
}
