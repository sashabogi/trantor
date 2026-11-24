// The Dashboard's smaller panels: stat tiles, Your move, Collisions, Machines (#13986).
import { Flame, Server, Wallet } from "lucide-react";
import type { Economics, FileHold, MachinesHealthReport } from "../../../shared/api/client";
import { machineHealthLine, machineStale } from "../../../features/fleet/MachineHealth";
import type { Navigate } from "../../routes";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { ProjectTile } from "../../ui/ProjectTile";
import { Section } from "../../ui/Section";
import { span, type Seat } from "./model";
import type { Decisions } from "./useDecisions";

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-[var(--v2-edge)] bg-[var(--v2-panel)] px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--v2-muted)]"><Wallet size={12} aria-hidden />{label}</div>
      <div className="mt-1 text-[20px] font-semibold text-[var(--v2-text)]">{value}</div>
      <div className="mt-0.5 truncate text-[11px] text-[var(--v2-muted)]">{sub}</div>
    </div>
  );
}

/** Only tiles the hub can back with a number: savings, notional spend, fleet size. */
export function StatTiles({ econ, projects, cards, live }: { econ: Economics | null; projects: number; cards: number; live: number }) {
  const life = econ?.windows?.lifetime;
  const kinds = econ?.costKinds?.lifetime ?? {};
  const notional = (kinds["subagent-notional"]?.usd ?? 0) + (kinds["orchestrator-notional"]?.usd ?? 0);
  return (
    <div className="flex gap-3">
      <Tile label="Saved vs frontier" value={life ? `$${life.saved_usd.toFixed(0)}` : "—"}
        sub={life ? `$${life.cost_usd.toFixed(2)} spent · ${life.calls.toLocaleString()} calls` : "no ledger on this machine"} />
      <Tile label="Claude, notional" value={notional ? `$${Math.round(notional).toLocaleString()}` : "—"} sub="plan-covered, never billed" />
      <Tile label="Fleet" value={`${projects} projects`} sub={`${live} live seat${live === 1 ? "" : "s"} · ${cards.toLocaleString()} cards`} />
    </div>
  );
}

export type Move = { key: string; project: string; title: string; sub: string; action: string; go: () => void };

/** What is yours to do whenever you like: interrupted sessions to resume, idle seats with no card. */
export function YourMove({ moves }: { moves: Move[] }) {
  return (
    <Section title="Your move, when you're ready" sub={`${moves.length} item${moves.length === 1 ? "" : "s"}`} flush>
      {moves.length === 0 && <p className="m-0 px-3.5 py-3 text-[12.5px] text-[var(--v2-muted)]">Nothing is waiting for you to start.</p>}
      {moves.map(m => (
        <div key={m.key} className="flex items-center gap-2.5 border-b border-[var(--v2-edge)] px-3.5 py-2 last:border-b-0">
          <ProjectTile name={m.project} size={22} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] text-[var(--v2-text)]">{m.title}</span>
            <span className="block truncate text-[11px] text-[var(--v2-muted)]">{m.project} · {m.sub}</span>
          </span>
          <Button onClick={m.go}>{m.action}</Button>
        </div>
      ))}
    </Section>
  );
}

export function idleMoves(seats: Seat[], go: Navigate): Move[] {
  return seats.filter(s => s.presence === "ready" && !s.card).map(s => ({
    key: `idle:${s.project}:${s.session}`, project: s.project, title: `Give ${s.session} its next card`,
    sub: `idle ${span(s.lastSeen)}`, action: "Open board", go: () => go("board", s.project),
  }));
}

function HoldCard({ hold, d }: { hold: FileHold; d: Decisions }) {
  const off = d.busy ? "Saving a decision" : null;
  return (
    <div className="border-b border-[var(--v2-edge)] px-3.5 py-3 last:border-b-0">
      <div className="flex items-center gap-2 text-[12.5px]">
        <ProjectTile name={hold.project} size={16} />
        <span className="v2-mono min-w-0 flex-1 truncate text-[var(--v2-text)]">{hold.file}</span>
        <span className="text-[11px] text-[var(--v2-muted)]">held {span(hold.ts)}</span>
      </div>
      <div className="mt-2 flex items-center gap-4 text-[12px] text-[var(--v2-text-2)]">
        <span className="flex items-center gap-1.5"><Avatar name={hold.session} size={18} />{hold.session} wants to edit</span>
        <span className="flex items-center gap-1.5"><Avatar name={hold.other} size={18} />{hold.other} holds the claim</span>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button disabledReason={off} onClick={() => void d.decideHold(hold, "go")}>{hold.session} goes first</Button>
        <Button disabledReason={off} onClick={() => void d.decideHold(hold, "nogo")}>{hold.other} goes first</Button>
        <Button variant="quiet" disabledReason="Comparing both changes needs a diff API the hub does not have yet">Compare both changes</Button>
      </div>
    </div>
  );
}

export function Collisions({ holds, d }: { holds: FileHold[]; d: Decisions }) {
  const live = holds.filter(h => !d.decided.has(`hold:${h.id}`));
  return (
    <section id="v2-collisions">
      <Section title="Collisions" sub={`${live.length} held`} actions={<Flame size={14} aria-hidden className="text-[var(--v2-warn)]" />} flush>
        {live.length === 0 && <p className="m-0 px-3.5 py-3 text-[12.5px] text-[var(--v2-muted)]">No two seats are fighting over a file.</p>}
        {live.map(h => <HoldCard key={h.id} hold={h} d={d} />)}
      </Section>
    </section>
  );
}

function Bar({ label, pct, text }: { label: string; pct: number; text: string }) {
  return (
    <div>
      <div className="flex justify-between text-[11px] text-[var(--v2-muted)]"><span>{label}</span><span className="v2-mono">{text}</span></div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--v2-track)]">
        <div className="h-full rounded-full bg-[var(--v2-accent)]" style={{ width: `${Math.min(100, Math.max(0, Math.round(pct)))}%` }} />
      </div>
    </div>
  );
}

export function Machines({ report }: { report: MachinesHealthReport | null }) {
  const rows = report?.machines ?? [];
  return (
    <aside aria-label="Machines and system" className="flex w-[240px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--v2-edge)] bg-[var(--v2-chrome)] p-3">
      <h2 className="m-0 flex items-center gap-1.5 text-[13px] font-semibold"><Server size={14} aria-hidden />Machines</h2>
      {rows.length === 0 && <p className="m-0 text-[12px] text-[var(--v2-muted)]">No machine has reported health to this hub.</p>}
      {rows.map(m => {
        const stale = machineStale(m, report?.staleAfterMs);
        return (
          <div key={m.machine} data-machine={m.machine} className="flex flex-col gap-2 rounded-xl border border-[var(--v2-edge)] bg-[var(--v2-panel)] p-3" style={{ opacity: stale ? 0.55 : 1 }}>
            <div className="flex items-center justify-between text-[12.5px] font-medium">
              <span>{m.machine}</span><span className="text-[11px] font-normal text-[var(--v2-muted)]">{stale ? "stale" : machineHealthLine(m)}</span>
            </div>
            <Bar label="Load" pct={m.cpuPct} text={`${Math.round(m.cpuPct)}%`} />
            <Bar label="Memory" pct={m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0} text={m.memTotal ? `${Math.round((m.memUsed / m.memTotal) * 100)}%` : "unknown"} />
          </div>
        );
      })}
    </aside>
  );
}
