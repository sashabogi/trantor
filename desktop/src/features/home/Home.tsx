// HOME — the overseer's screen, and the app's default view. One glance answers: is work moving,
// who is live, what needs me, what did it cost, what did we learn. This is where the fleet-level
// telemetry LIVES — it used to be crammed into the project tab strip as raw text, which is exactly
// the altitude mistake the IA forbids: fleet data does not belong in project chrome.
//
// Two hubs feed it by design: economics/balances come from the MACHINE-LOCAL hub (the Scrooge
// ledger and profile.json are files on this machine); cards/peers/lessons ride the project hub.
import { useEffect, useState } from "react";
import { HubClient } from "../../shared/api/client";
import { cleanTitle } from "../../shared/Avatar";
import type { BalancesReport, Card, Economics, Handoff, Peer } from "../../shared/api/client";

const LOCAL_HUB = "http://127.0.0.1:4477";
const ONLINE_MS = 5 * 60 * 1000;

type Snapshot = {
  econ: Economics | null; balances: BalancesReport | null;
  cards: Card[]; peers: Peer[]; lessons: { text: string; scope: string; by: string; ts: number }[];
  handoffs: Handoff[];
};
const cache: { snap: Snapshot | null } = { snap: null };

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="tr-card flex min-w-0 flex-1 flex-col gap-1 p-5">
      <div className="text-[12px] font-medium text-[var(--color-tr-muted)]">{label}</div>
      <div className="tr-mono text-[22px] font-semibold" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub && <div className="truncate text-[12px] text-[var(--color-tr-muted)]">{sub}</div>}
    </div>
  );
}

export function Home({ client, me, onOpenProject }: {
  client: HubClient; me: string; onOpenProject: (project: string) => void;
}) {
  const [snap, setSnap] = useState<Snapshot | null>(cache.snap);

  useEffect(() => {
    let alive = true;
    const isLocal = client.baseUrl.includes("127.0.0.1") || client.baseUrl.includes("localhost");
    const local = isLocal ? client : new HubClient(LOCAL_HUB);
    const pull = async () => {
      const [econ, balances, cards, peers, learning, handoffs] = await Promise.all([
        local.economics().catch(() => null),
        local.balances().catch(() => null),
        client.tasks().catch(() => [] as Card[]),
        client.peers().catch(() => [] as Peer[]),
        client.learning().catch(() => null),
        client.handoffs().catch(() => [] as Handoff[]),
      ]);
      if (!alive) return;
      const lessons = learning
        ? [...learning.lessons.global, ...Object.values(learning.lessons.byAgent).flat()]
            .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 6)
        : [];
      const s = { econ, balances, cards, peers, lessons, handoffs: handoffs.slice(0, 5) };
      cache.snap = s;
      setSnap(s);
    };
    void pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);

  const lifetime = snap?.econ?.windows?.lifetime;
  const ck = snap?.econ?.costKinds?.lifetime ?? {};
  const notional = (ck["subagent-notional"]?.usd ?? 0) + (ck["orchestrator-notional"]?.usd ?? 0);
  const now = Date.now();
  const live = (snap?.peers ?? []).filter(p => p.online || (p.lastSeen && now - p.lastSeen < ONLINE_MS));
  const projects = new Set((snap?.cards ?? []).map(c => c.project).filter(Boolean));
  const attention = (snap?.cards ?? [])
    .filter(c => ["failed", "blocked", "stale"].includes(c.status))
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, 6);

  return (
    <div className="tr-pane h-full overflow-y-auto px-10 py-8">
      <header className="mb-7">
        <h1 className="tr-page-title">Home</h1>
        <p className="tr-page-sub">Your fleet at a glance, {me.split("@")[0]}.</p>
      </header>

      {/* the four numbers that used to be a text dump in the header */}
      <div className="mb-8 flex gap-4">
        <StatCard label="Saved vs frontier" tone="var(--color-tr-ok)"
                  value={lifetime ? `$${lifetime.saved_usd.toFixed(0)}` : "—"}
                  sub={lifetime ? `$${lifetime.cost_usd.toFixed(2)} spent · ${lifetime.calls.toLocaleString()} calls` : "no ledger on this machine"} />
        <StatCard label="Claude notional" value={notional ? `$${Math.round(notional).toLocaleString()}` : "—"}
                  sub="plan-covered, never billed" />
        <StatCard label="Fleet" value={`${projects.size} projects`}
                  sub={`${live.length} live session${live.length === 1 ? "" : "s"} · ${(snap?.cards ?? []).length.toLocaleString()} cards`} />
        <div className="tr-card flex min-w-0 flex-1 flex-col gap-2 p-5">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-[var(--color-tr-muted)]">Providers</span>
            {snap?.balances?.stale && <span className="text-[11px] text-[var(--color-tr-warn)]">stale</span>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(snap?.balances?.entries ?? []).map(e => (
              <span key={e.provider} className="tr-chip"
                    style={e.low ? { color: "var(--color-tr-fail)" } : undefined}
                    title={`${e.provider} · ${e.kind}${e.plan ? ` · ${e.plan}` : ""}`}>
                <span className="tr-dot" style={{ background: e.low ? "var(--color-tr-fail)" : "var(--color-tr-ok)" }} />
                {e.kind === "prepaid" ? `${e.label || e.provider}${e.remaining != null ? ` $${e.remaining.toFixed(0)}` : ""}`
                 : e.kind === "quota" ? `${e.label || e.provider} ${e.remainingPct ?? "?"}%`
                 : `${e.label || e.provider}`}
              </span>
            ))}
            {!snap?.balances?.entries?.length && <span className="text-[12px] text-[var(--color-tr-muted)]">—</span>}
          </div>
        </div>
      </div>

      <div className="flex gap-8">
        {/* what needs a human */}
        <div className="flex min-w-0 flex-1 flex-col gap-8">
        <section className="min-w-0">
          <h2 className="tr-sec-title">Needs attention</h2>
          <p className="tr-sec-sub">Failed, blocked and stale cards across every project.</p>
          <div className="mt-3 flex flex-col gap-2">
            {attention.map(c => (
              <button key={c.id} onClick={() => onOpenProject(c.project)}
                      className="tr-card tr-card-hover flex items-center gap-3 p-3.5 text-left">
                <span className="tr-dot shrink-0"
                      style={{ background: c.status === "stale" ? "var(--color-tr-muted)" : "var(--color-tr-fail)" }} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{cleanTitle(c.title)}</span>
                <span className="tr-chip shrink-0">{c.project}</span>
                <span className="tr-chip shrink-0">{c.status}</span>
              </button>
            ))}
            {!attention.length && (
              <div className="tr-card-ghost flex items-center justify-center p-6 text-[13px]">
                Nothing needs you — the board is clean.
              </div>
            )}
          </div>
        </section>

        <section className="min-w-0">
          <h2 className="tr-sec-title">Handoffs</h2>
          <p className="tr-sec-sub">Batons passed between sessions — context that survived a context window.</p>
          <div className="mt-3 flex flex-col gap-2">
            {(snap?.handoffs ?? []).map((h, i) => (
              <button key={i} onClick={() => onOpenProject(h.project)}
                      className="tr-card tr-card-hover flex items-center gap-3 p-3.5 text-left">
                <span className="min-w-0 flex-1 truncate text-[13px]">{h.session}</span>
                <span className="tr-chip shrink-0">{h.project}</span>
                {h.trigger && <span className="tr-chip shrink-0">{h.trigger}</span>}
                <span className="shrink-0 text-[11px] text-[var(--color-tr-muted)]">
                  {h.ts ? new Date(h.ts).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}
                </span>
              </button>
            ))}
            {!snap?.handoffs?.length && (
              <div className="tr-card-ghost flex items-center justify-center p-5 text-[13px]">No handoffs yet.</div>
            )}
          </div>
        </section>
        </div>

        {/* what the fleet learned */}
        <section className="min-w-0 flex-1">
          <h2 className="tr-sec-title">Latest lessons</h2>
          <p className="tr-sec-sub">What the agents learned while building.</p>
          <div className="mt-3 flex flex-col gap-2">
            {(snap?.lessons ?? []).map((l, i) => (
              <div key={i} className="tr-card p-3.5">
                <div className="text-[13px] leading-snug">{l.text}</div>
                <div className="mt-1.5 flex gap-2 text-[11px] text-[var(--color-tr-muted)]">
                  {l.scope !== "global" && <span className="tr-chip">{l.scope}</span>}
                  <span>{l.ts ? new Date(l.ts).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}</span>
                </div>
              </div>
            ))}
            {!snap?.lessons?.length && (
              <div className="tr-card-ghost flex items-center justify-center p-6 text-[13px]">No lessons yet.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
