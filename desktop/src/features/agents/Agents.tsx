// AGENTS — the roster. Humans and agents are both peers on the bus; the difference is `kind`, not
// a separate concept. This is the view Buzz got right and nobody else has: which harnesses exist,
// which are alive, and what each is doing right now — and Buzz's Agents screen is the design
// reference for the whole app, so THIS view carries its language hardest: a card grid with big
// colorful avatars for the harnesses, quiet rows for the live sessions.
//
// Presence is derived, not stored: the hub's heartbeat fires on PostToolUse, so a FRESH lastSeen
// means "actively calling tools" and a stale one means idle-at-the-prompt. That distinction is the
// whole reason the wake ladder exists, so it is surfaced here rather than flattened to a dot.
import { useEffect, useState } from "react";
import { doctor, type DoctorReport } from "../../shared/api/client";
import type { HubClient, Peer } from "../../shared/api/client";
import { Avatar } from "../../shared/Avatar";

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
const projectOf = (session: string) => (session.includes(":") ? session.split(":").slice(1).join(":") : "");

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
  const [health, setHealth] = useState<DoctorReport | null>(null);

  // Harness detection: WHICH seats could run at all, as opposed to which happen to be alive. A brand
  // missing from here can never come up, and no amount of staring at presence dots will say why —
  // that was the single most portable idea in Buzz's onboarding.
  useEffect(() => { doctor().then(setHealth).catch(() => {}); }, []);

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

  if (error) return <div className="p-10 text-sm text-[var(--color-tr-fail)]">Agents unavailable: {error}</div>;
  if (!peers) return <div className="p-10 text-sm text-[var(--color-tr-muted)]">Loading roster…</div>;

  // This project first — that is what the operator is looking at — then everyone else for context,
  // because a seat busy on ANOTHER project is exactly what explains a quota stall here.
  const mine = peers.filter(p => p.project === project);
  const others = peers.filter(p => p.project !== project);
  const live = peers.filter(p => stateOf(p) !== "offline").length;

  const Row = ({ p }: { p: Peer }) => {
    const st = stateOf(p);
    const proj = p.project || projectOf(p.session);
    return (
      <div className="tr-card flex items-center gap-3 px-4 py-3">
        <span className="relative shrink-0">
          <Avatar name={brandOf(p.session)} size={30} />
          <span className="tr-dot absolute -right-0.5 -bottom-0.5 border-2 border-[var(--color-tr-panel)]"
                style={{ background: COLOR[st], width: 9, height: 9 }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px]">{brandOf(p.session)}</span>
            {proj && <span className="tr-chip shrink-0">{proj}</span>}
          </div>
          <div className="truncate text-[12px] text-[var(--color-tr-muted)]">{p.status || "—"}</div>
        </div>
        <div className="shrink-0 text-right text-[11px] text-[var(--color-tr-muted)]">
          <div>{st}</div>
          <div className="opacity-70">{ago(p.lastSeen)}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="tr-pane flex h-full flex-col">
      <header className="px-10 pt-8 pb-5">
        <h1 className="tr-page-title">Agents</h1>
        <p className="tr-page-sub">{live} live · {peers.length} known across the fleet.</p>
      </header>
      <div className="flex-1 overflow-y-auto px-10 pb-8">
        {health && (() => {
          const crew = [
            ...health.ok.filter(e => e.section.startsWith("crew")).map(e => ({ ...e, state: "ok" as const })),
            ...health.issues.filter(e => e.section.startsWith("crew")).map(e => ({ ...e, state: "bad" as const })),
            ...health.notes.filter(e => e.section.startsWith("crew")).map(e => ({ ...e, state: "missing" as const })),
          ];
          // "codex: wired to the bus" / "codex: authenticated" -> one card per brand, both facts.
          const byBrand = new Map<string, { wired?: boolean; auth?: boolean; missing?: boolean; fix?: string | null }>();
          for (const e of crew) {
            const brand = e.message.split(":")[0].trim();
            const cur = byBrand.get(brand) ?? {};
            if (e.state === "missing") cur.missing = true;
            else if (/authenticated/i.test(e.message)) cur.auth = e.state === "ok";
            else if (/wired/i.test(e.message)) cur.wired = e.state === "ok";
            if (e.state === "bad" && e.fix) cur.fix = e.fix;
            byBrand.set(brand, cur);
          }
          return (
            <section className="mb-8">
              <h2 className="tr-sec-title">Harnesses</h2>
              <p className="tr-sec-sub">
                The seats a crew can run on this machine.
                {health.issueCount > 0 && <span className="text-[var(--color-tr-fail)]"> {health.issueCount} issue(s).</span>}
              </p>
              <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
                {[...byBrand.entries()].map(([brand, st]) => {
                  const ready = st.wired && st.auth;
                  const name = brand.split(" ")[0];
                  return (
                    <div key={brand} title={st.fix ?? brand} className="tr-card tr-card-hover flex flex-col items-center gap-3 p-5">
                      <span className="relative">
                        <Avatar name={name} />
                        <span className="tr-dot absolute -right-0.5 -bottom-0.5 border-2 border-[var(--color-tr-panel)]"
                              style={{
                                background: st.missing ? "var(--color-tr-edge)" : ready ? "var(--color-tr-ok)" : "var(--color-tr-fail)",
                                width: 11, height: 11,
                              }} />
                      </span>
                      <div className="w-full text-center">
                        <div className="truncate text-[13px] font-medium">{name}</div>
                        <div className="mt-0.5 text-[11px] text-[var(--color-tr-muted)]">
                          {st.missing ? "not installed" : ready ? "ready" : !st.wired ? "not wired" : "not authenticated"}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="tr-card-ghost flex min-h-[120px] flex-col items-center justify-center gap-1 p-5"
                     title="Any opencode provider can become a seat">
                  <span className="text-xl leading-none">+</span>
                  <span className="text-[12px]">Add a seat</span>
                  <code className="text-[10px] opacity-70">trantor provider add</code>
                </div>
              </div>
            </section>
          );
        })()}

        <section className="mb-8">
          <h2 className="tr-sec-title">On {project}</h2>
          <p className="tr-sec-sub">Sessions in the project you're looking at.</p>
          <div className="mt-3 flex flex-col gap-2">
            {mine.length ? mine.map(p => <Row key={p.session} p={p} />)
              : <div className="tr-card-ghost flex items-center justify-center p-5 text-[13px]">No agents on this project right now.</div>}
          </div>
        </section>

        {others.length > 0 && (
          <section>
            <h2 className="tr-sec-title">Elsewhere</h2>
            <p className="tr-sec-sub">A seat busy on another project is exactly what explains a stall here.</p>
            <div className="mt-3 flex flex-col gap-2 opacity-80">
              {others.map(p => <Row key={p.session} p={p} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
