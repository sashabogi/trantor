import { useEffect, useRef, useState } from "react";
import { availableAgent, balanceFor, canStart, crewApi, parkReason, quotaLabel, type CrewAction, type CrewApi, type CrewCatalog, type SeatWhy } from "./crewControlApi";

export function CrewControls({ project, seats, onChanged, api = crewApi }: {
  project: string; seats: string[]; onChanged: () => void; api?: CrewApi;
}) {
  const [catalog, setCatalog] = useState<CrewCatalog | null>(null);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    let alive = true;
    api.catalog(project).then(c => { if (alive) setCatalog(c); }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [api, project]);
  const names = [...new Set([...seats, ...added])];
  return <div className="my-2 flex flex-col gap-1" aria-label="Crew controls">
    {names.map(seat => <CrewSeatRow key={seat} project={project} seat={seat} catalog={catalog} api={api} onChanged={onChanged} />)}
    <div className="relative text-[12px]">
      <button type="button" className="tr-chip" aria-expanded={adding} onClick={() => setAdding(!adding)}>Add seat</button>
      {adding && <div className="tr-card mt-1 flex flex-wrap gap-2 p-2">
        {!catalog && !error && <span role="status">Loading available seats…</span>}
        {catalog?.agents.filter(a => !names.includes(a.id)).map(a => <button type="button" key={a.id}
          className="tr-chip disabled:opacity-50" disabled={!availableAgent(a, catalog.balances)}
          onClick={() => { setAdded(old => [...old, a.id]); setAdding(false); }}>
          {a.label} · {quotaLabel(balanceFor(a, catalog.balances))}{!a.installed ? " · not installed" : !a.enabled ? " · disabled" : ""}
        </button>)}
      </div>}
    </div>
    {error && <span role="alert" className="text-[12px] text-tr-fail">Seat catalog unavailable: {error}</span>}
  </div>;
}

export function CrewSeatRow({ project, seat, catalog, api, onChanged }: {
  project: string; seat: string; catalog: CrewCatalog | null; api: CrewApi; onChanged: () => void;
}) {
  const [why, setWhy] = useState<SeatWhy | null>(null);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [failed, setFailed] = useState(false);
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
    if (locked.current) return;
    locked.current = true;
    generation.current += 1;
    setBusy(true); setFailed(false); setMenu(false);
    setOutcome(command === "up" ? "Starting…" : command === "down" ? "Stopping…" : "Swapping…");
    try {
      const launch = catalog?.agents.find(a => a.id === seat)?.launch ?? seat;
      const result = await api.action(project, command, command === "up" ? launch : seat, replacement);
      if (!mounted.current) return;
      setFailed(!result.ok);
      setOutcome(result.ok ? command === "up" ? "Started" : command === "down" ? "Stopped" : `Swapped to ${result.to}` : result.reason ?? `${command} failed`);
    } catch (e) { if (mounted.current) { setFailed(true); setOutcome(String(e)); } }
    finally {
      try {
        const latest = await api.why(project, seat);
        if (mounted.current) { setWhy(latest); setError(""); }
      } catch (e) { if (mounted.current) { setWhy(null); setError(String(e)); } }
      locked.current = false;
      if (mounted.current) { setBusy(false); onChanged(); }
    }
  };
  const start = why && canStart(why.state);
  const live = why && ["live", "no-pane", "parked"].includes(why.state);
  return <div className="tr-card flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]" aria-label={`${seat} controls`}>
    <span className="tr-mono">{seat}</span>
    <span>{why?.state ?? "Checking…"}</span>
    {why?.state === "parked" && <span>{parkReason(why)}</span>}
    {start && <button type="button" className="tr-chip" disabled={busy} onClick={() => void action("up")}>Start</button>}
    <button type="button" className="tr-chip" disabled={busy || !why} aria-expanded={menu} aria-label={`${seat} actions`} onClick={() => setMenu(!menu)}>Actions</button>
    {menu && <div className="flex flex-wrap items-center gap-2" aria-label={`${seat} action menu`}>
      {start && <button type="button" className="tr-chip" onClick={() => void action("up")}>Start</button>}
      {live && <button type="button" className="tr-chip" onClick={() => void action("down")}>Stop</button>}
      {live && <label>Swap to… <select aria-label={`Swap ${seat} to`} value="" disabled={!catalog} onChange={e => { if (e.target.value) void action("swap", e.target.value); }}>
        <option value="">Choose seat</option>
        {catalog?.agents.filter(a => a.id !== seat).map(a => <option key={a.id} value={a.launch} disabled={!availableAgent(a, catalog.balances)}>
          {a.label} · {quotaLabel(balanceFor(a, catalog.balances))}
        </option>)}
      </select></label>}
    </div>}
    {outcome && <span role={failed ? "alert" : "status"}>{outcome}</span>}
    {error && <span role="alert">State unavailable: {error}</span>}
  </div>;
}
