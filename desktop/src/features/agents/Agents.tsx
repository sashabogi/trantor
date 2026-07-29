// AGENTS — the roster. Humans and agents are both peers on the bus; the difference is `kind`, not
// a separate concept. This is the view Buzz got right and nobody else has: which harnesses exist,
// which are alive, and what each is doing right now.
//
// Presence is derived, not stored: the hub's heartbeat fires on PostToolUse, so a FRESH lastSeen
// means "actively calling tools" and a stale one means idle-at-the-prompt. That distinction is the
// whole reason the wake ladder exists, so it is surfaced here rather than flattened to a dot.
import { useEffect, useState } from "react";
import type { HubClient, Peer } from "../../shared/api/client";

const ONLINE_MS = 5 * 60 * 1000;   // matches the hub's RELAY_ONLINE_MS default
const BUSY_MS = 90 * 1000;         // heartbeat is ~60s, so fresher than this means mid-turn

type State = "busy" | "idle" | "offline";
function stateOf(p: Peer): State {
  const age = Date.now() - (p.lastSeen ?? 0);
  if (age > ONLINE_MS) return "offline";
  return age < BUSY_MS ? "busy" : "idle";
}
const COLOR: Record<State, string> = {
  busy: "var(--color-tr-doing)",
  idle: "var(--color-tr-muted)",
  offline: "var(--color-tr-edge)",
};

// A seat's identity is `<brand>:<project>`; the human sessions are `<host>:<project>`. Splitting on
// the colon gives the brand, which is what the operator actually thinks in ("is codex up?").
const brandOf = (session: string) => session.split(":")[0] ?? session;

function ago(ts?: number) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export function Agents({ client, project }: { client: HubClient; project: string }) {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => client.peers()
      .then(p => { if (alive) { setPeers(p); setError(null); } })
      .catch(e => { if (alive) setError(String(e.message || e)); });
    load();
    // Presence decays on a timer, so poll rather than relying purely on events — a peer going quiet
    // produces no event until the hub's 60s sweep notices.
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);

  useEffect(() => client.streamEvents(ev => {
    if (ev.type?.startsWith("presence")) client.peers().then(setPeers).catch(() => {});
  }), [client]);

  if (error) return <div className="p-6 text-sm text-[var(--color-tr-fail)]">Agents unavailable: {error}</div>;
  if (!peers) return <div className="p-6 text-sm text-[var(--color-tr-muted)]">Loading roster…</div>;

  // This project first — that is what the operator is looking at — then everyone else for context,
  // because a seat busy on ANOTHER project is exactly what explains a quota stall here.
  const mine = peers.filter(p => p.project === project);
  const others = peers.filter(p => p.project !== project);
  const live = peers.filter(p => stateOf(p) !== "offline").length;

  const Row = ({ p }: { p: Peer }) => {
    const st = stateOf(p);
    return (
      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-tr-edge)] bg-[var(--color-tr-panel)] px-3 py-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLOR[st] }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{brandOf(p.session)}</div>
          <div className="truncate text-[11px] text-[var(--color-tr-muted)]">{p.status || "—"}</div>
        </div>
        <div className="shrink-0 text-right text-[11px] text-[var(--color-tr-muted)]">
          <div>{st}</div>
          <div className="opacity-70">{ago(p.lastSeen)}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-[var(--color-tr-edge)] px-5 py-3">
        <h1 className="text-base font-semibold">agents</h1>
        <span className="text-xs text-[var(--color-tr-muted)]">{live} live · {peers.length} known</span>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-tr-muted)]">{project}</div>
        <div className="mb-6 flex flex-col gap-2">
          {mine.length ? mine.map(p => <Row key={p.session} p={p} />)
            : <div className="text-sm text-[var(--color-tr-muted)]">No agents on this project.</div>}
        </div>
        {others.length > 0 && (
          <>
            <div className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-tr-muted)]">elsewhere</div>
            <div className="flex flex-col gap-2 opacity-70">
              {others.map(p => <Row key={p.session} p={p} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
