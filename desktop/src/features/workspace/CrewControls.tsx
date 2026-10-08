import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { SeatTab } from "./SeatTab";
import type { PaneTarget } from "./paneTargets";
import { availableAgent, balanceFor, canStart, crewApi, parkReason, quotaLabel, type CrewAction, type CrewApi, type CrewCatalog, type SeatWhy } from "./crewControlApi";

const menuItem = "block w-full rounded px-3 py-1.5 text-left text-[12px] text-tr-text hover:bg-tr-panel disabled:opacity-50";
type Report = (text: string, failed?: boolean, busy?: boolean) => void;

function TabMenu({ anchor, label, close, children }: {
  anchor: HTMLElement | null; label: string; close: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target) && !anchor?.contains(e.target)) close(); };
    const scroll = () => close();
    document.addEventListener("pointerdown", outside);
    anchor?.parentElement?.addEventListener("scroll", scroll);
    return () => {
      document.removeEventListener("pointerdown", outside);
      anchor?.parentElement?.removeEventListener("scroll", scroll);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [anchor, close]);
  const rect = anchor?.getBoundingClientRect();
  return createPortal(<div ref={ref} role="menu" aria-label={label}
    className="fixed z-50 w-64 overflow-y-auto rounded-md border border-tr-edge bg-tr-bg p-1 shadow-lg"
    style={{ left: Math.max(8, Math.min(rect?.left ?? 8, window.innerWidth - 264)), top: (rect?.bottom ?? 0) + 4, maxHeight: "60vh" }}
    onKeyDown={e => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = items.findIndex(item => item === document.activeElement);
        items[(index + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
      if (e.key === "Tab") close();
    }}>{children}</div>, document.body);
}

export function CrewControls({ project, targets, selected, onSelect, onChanged, children, api = crewApi }: {
  project: string; targets: PaneTarget[]; selected?: string; onSelect: (target: PaneTarget) => void;
  onChanged: () => void; children?: ReactNode; api?: CrewApi;
}) {
  const [catalog, setCatalog] = useState<CrewCatalog | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState({ text: "", failed: false, busy: false });
  const addAnchor = useRef<HTMLButtonElement>(null);
  const closeAdd = useCallback(() => setAdding(false), []);
  const report: Report = useCallback((text, failed = false, busy = false) => setNotice({ text, failed, busy }), []);
  useEffect(() => {
    if (!notice.text || notice.busy) return;
    const timer = setTimeout(() => setNotice({ text: "", failed: false, busy: false }), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    let alive = true;
    const load = () => api.catalog(project).then(c => { if (alive) setCatalog(c); })
      .catch(e => { if (alive) report(`Seat catalog unavailable: ${String(e)}`, true); });
    void load();
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [api, project, report]);
  const names = targets.filter(t => !t.isOrchestrator).map(t => t.agent);
  const extra: PaneTarget[] = added.filter(name => !names.includes(name)).map(name => ({ key: `${name}:${project}`, label: name,
    agent: name, brand: name, session: `${name}:${project}`, online: false, isOrchestrator: false }));
  return <>
    <div className="flex min-w-0 max-w-full items-center gap-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Seat tabs">
      {[...targets, ...extra].map(t => t.isOrchestrator
        ? <SeatTab key={t.key} name={t.label} brandName={t.brand} status={t.status} active={selected === t.key} onClick={() => onSelect(t)} you />
        : <CrewSeatTab key={t.key} project={project} target={t} active={selected === t.key} onSelect={() => onSelect(t)}
          catalog={catalog} api={api} onChanged={onChanged} report={report} actionPending={notice.busy} />)}
      </div>
      <button ref={addAnchor} type="button" aria-label="Add seat" title="Add seat" aria-haspopup="menu" aria-expanded={adding}
        className="shrink-0 rounded-[9px] px-3 py-[7px] text-tr-muted hover:bg-tr-panel hover:text-tr-text"
        onClick={() => setAdding(!adding)}>+</button>
      {children}
    </div>
    {adding && <TabMenu anchor={addAnchor.current} label="Add seat" close={closeAdd}>
      {!catalog && <span className="px-3 text-[12px] text-tr-muted">Loading available seats…</span>}
      {catalog?.agents.filter(a => !names.includes(a.id) && !added.includes(a.id)).map(a =>
        <button role="menuitem" type="button" key={a.id} className={menuItem} disabled={!availableAgent(a, catalog.balances)}
          onClick={() => { setAdded(old => [...old, a.id]); setAdding(false); }}>
          {a.label} · {quotaLabel(balanceFor(a, catalog.balances))}
        </button>)}
    </TabMenu>}
    {notice.text && <div role={notice.failed ? "alert" : "status"} className="mt-1 truncate text-[12px] text-tr-muted" title={notice.text}>{notice.text}</div>}
  </>;
}

function CrewSeatTab({ project, target, active, onSelect, catalog, api, onChanged, report, actionPending }: {
  project: string; target: PaneTarget; active: boolean; onSelect: () => void;
  catalog: CrewCatalog | null; api: CrewApi; onChanged: () => void; report: Report; actionPending: boolean;
}) {
  const seat = target.agent;
  const [why, setWhy] = useState<SeatWhy | null>(null);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [swap, setSwap] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  const locked = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let pending = false;
    const refresh = async () => {
      if (pending || locked.current) return;
      pending = true;
      const version = generation.current;
      try {
        const result = await api.why(project, seat);
        if (mounted.current && version === generation.current) { setWhy(result); setError(""); }
      } catch (e) { if (mounted.current && version === generation.current) { setWhy(null); setError(String(e)); } }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [api, project, seat]);
  const action = async (command: CrewAction, replacement?: string) => {
    if (locked.current || actionPending) return;
    locked.current = true;
    generation.current += 1;
    setBusy(true); setMenu(false);
    report(`${seat} · ${command === "up" ? "Starting…" : command === "down" ? "Stopping…" : "Swapping…"}`, false, true);
    try {
      const launch = catalog?.agents.find(a => a.id === seat)?.launch ?? seat;
      const result = await api.action(project, command, command === "up" ? launch : seat, replacement);
      if (!mounted.current) return;
      report(`${seat} · ${result.ok ? command === "up" ? "Started" : command === "down" ? "Stopped" : `Swapped to ${result.to}` : result.reason ?? `${command} failed`}`, !result.ok);
    } catch (e) { if (mounted.current) { report(`${seat} · ${String(e)}`, true); } }
    finally {
      try {
        const latest = await api.why(project, seat);
        if (mounted.current) { setWhy(latest); setError(""); }
      } catch (e) { if (mounted.current) { setWhy(null); setError(String(e)); } }
      locked.current = false;
      if (mounted.current) { setBusy(false); onChanged(); }
    }
  };
  const closeMenu = useCallback(() => { setMenu(false); setSwap(false); }, []);
  const start = why && canStart(why.state);
  const live = why && ["live", "no-pane", "parked"].includes(why.state);
  const state = why?.state === "parked" ? "parked" : start ? "down" : live ? "live" : "unknown";
  return <div ref={anchor} className="group flex shrink-0 items-center"
    onContextMenu={e => { e.preventDefault(); if (!busy && !actionPending && why) { setSwap(false); setMenu(true); } }}>
    <SeatTab name={target.label} brandName={target.brand} status={target.status} active={active} onClick={onSelect}
      state={state} tooltip={error ? `State unavailable: ${error}` : why?.state === "parked" ? `parked · ${parkReason(why)}` : undefined} />
    <button type="button" className="-ml-2 mr-1 rounded p-1 text-tr-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
      disabled={busy || actionPending || !why} aria-label={`${seat} actions`} aria-haspopup="menu" aria-expanded={menu}
      onClick={() => { setSwap(false); setMenu(!menu); }}><ChevronDown size={12} /></button>
    {menu && <TabMenu key={swap ? "swap" : "actions"} anchor={anchor.current} label={`${seat} action menu`} close={closeMenu}>
      {swap ? <>
        <button type="button" role="menuitem" className={menuItem} onClick={() => setSwap(false)}>‹ Back</button>
        {catalog?.agents.filter(a => a.id !== seat).map(a => <button type="button" role="menuitem" key={a.id} className={menuItem}
          disabled={!availableAgent(a, catalog.balances)} onClick={() => void action("swap", a.launch)}>
          {a.label} · {quotaLabel(balanceFor(a, catalog.balances))}
        </button>)}
      </> : <>
        {start && <button type="button" role="menuitem" className={menuItem} onClick={() => void action("up")}>Start</button>}
        {live && <button type="button" role="menuitem" className={menuItem} onClick={() => void action("down")}>Stop</button>}
        {live && <button type="button" role="menuitem" className={menuItem} disabled={!catalog} aria-haspopup="menu" onClick={() => setSwap(true)}>Swap to ▸</button>}
      </>}
    </TabMenu>}
  </div>;
}
