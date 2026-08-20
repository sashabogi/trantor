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
import { Avatar, displayName } from "../../shared/Avatar";
import { stateOf, ago, usePeers, PRESENCE_COLOR as COLOR, type PresenceState } from "../../shared/presence";

// A seat's identity is `<brand>:<project>`; the human sessions are `<host>:<project>`. Splitting on
// the colon gives the brand, which is what the operator actually thinks in ("is codex up?").
const projectOf = (session: string) => (session.includes(":") ? session.split(":").slice(1).join(":") : "");

// Live first, and busy before merely-online — the roster answers "who is working right now" before
// it archives who has ever existed. Within a state, most-recently-seen first.
const ORDER = { busy: 0, idle: 1, offline: 2 } as const satisfies Record<PresenceState, number>;
const byLiveness = (a: Peer, b: Peer) =>
  ORDER[stateOf(a)] - ORDER[stateOf(b)] || (b.lastSeen ?? 0) - (a.lastSeen ?? 0);

export function Agents({ client, project }: { client: HubClient; project: string }) {
  const { peers, error } = usePeers(client);
  const [health, setHealth] = useState<DoctorReport | null>(null);

  // Harness detection: WHICH seats could run at all, as opposed to which happen to be alive. A brand
  // missing from here can never come up, and no amount of staring at presence dots will say why —
  // that was the single most portable idea in Buzz's onboarding.
  useEffect(() => { doctor().then(setHealth).catch(() => {}); }, []);

  if (error && !peers) return <div className="p-10 text-sm text-[var(--color-tr-fail)]">Agents unavailable: {error}</div>;
  if (!peers) return <div className="p-10 text-sm text-[var(--color-tr-muted)]">Loading roster…</div>;

  // This project first — that is what the operator is looking at — then everyone else for context,
  // because a seat busy on ANOTHER project is exactly what explains a quota stall here.
  const mine = [...peers.filter(p => p.project === project)].sort(byLiveness);
  const others = [...peers.filter(p => p.project !== project)].sort(byLiveness);
  const live = peers.filter(p => stateOf(p) !== "offline").length;
  const busy = peers.filter(p => stateOf(p) === "busy").length;

  const Row = ({ p }: { p: Peer }) => {
    const st = stateOf(p);
    const proj = p.project || projectOf(p.session);
    // Liveness must be discernible at a GLANCE, not by reading 11px state text: busy rows breathe
    // (pulsing dot) and carry a colored state word; offline rows drop to background opacity so the
    // living stand out from the archive. This was Sasha's direct complaint — "just a list that's
    // grayed out and hard to discern what's going on."
    return (
      <div className={`tr-card flex items-center gap-3 px-4 py-3 ${st === "offline" ? "opacity-45" : ""}`}>
        <span className="relative shrink-0">
          <Avatar name={p.session} llm={p.llm} size={30} />
          <span className={`tr-dot absolute -right-0.5 -bottom-0.5 border-2 border-[var(--color-tr-panel)] ${st === "busy" ? "tr-dot-pulse" : ""}`}
                style={{ background: COLOR[st], width: 9, height: 9 }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px]">{displayName(p.session, p.llm)}</span>
            {p.model && <span className="tr-chip tr-mono shrink-0">{p.model}</span>}
            {proj && <span className="tr-chip shrink-0">{proj}</span>}
          </div>
          <div className="truncate text-[12px] text-[var(--color-tr-muted)]">{p.status || "—"}</div>
        </div>
        <div className="shrink-0 text-right text-[11px]">
          <div style={{ color: st === "busy" ? "var(--color-tr-doing)" : st === "idle" ? "var(--color-tr-text)" : "var(--color-tr-muted)" }}>
            {st === "busy" ? "working" : st}
          </div>
          <div className="text-[var(--color-tr-muted)] opacity-70">{ago(p.lastSeen)}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="tr-pane flex h-full flex-col">
      <header className="px-10 pt-8 pb-5">
        <h1 className="tr-page-title">Agents</h1>
        <p className="tr-page-sub">{busy > 0 && <>{busy} working now · </>}{live} live · {peers.length} known across the fleet.</p>
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
            // Every per-seat line is "<brand>: <fact>". The section also carries aggregates with no
            // colon ("no crew CLIs found"), and splitting one of those produced a phantom seat card
            // named "no" — the first word of the warning, sitting where a real harness should be.
            const sep = e.message.indexOf(":");
            if (sep <= 0) continue;
            const brand = e.message.slice(0, sep).trim();
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
