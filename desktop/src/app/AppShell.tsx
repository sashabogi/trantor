// Shell — sidebar on the backdrop, content on a FLOATING main panel (the Buzz layout DNA).
//
// The IA is SCOPE, and the layout says so:
//   FLEET    Home, Inbox, Agents, Learning — cross-project by definition. Sidebar, top.
//   PROJECT  BOARD | FEED | CHAT — the only things that change when you pick a project.
//   APP      Settings + identity. Sidebar footer.
//
// Fleet telemetry (economics, providers, tallies) lives on the HOME view as designed cards —
// never in chrome. The old header dump was the altitude mistake made visible.
import { useEffect, useMemo, useState } from "react";
import { HubClient, hubForProject, knownProjects } from "../shared/api/client";
import { Home } from "../features/home/Home";
import { Board } from "../features/board/Board";
import { Feed } from "../features/feed/Feed";
import { Agents } from "../features/agents/Agents";
import { Inbox } from "../features/inbox/Inbox";
import { Learning } from "../features/learning/Learning";
import { Settings } from "../features/settings/Settings";
import { Conversation } from "../features/chat/Conversation";
import { notifyIfWorthIt } from "../shared/notify";

type Lens = "board" | "feed" | "chat";
type Pane =
  | { kind: "home" }
  | { kind: "project"; lens: Lens }
  | { kind: "inbox" }
  | { kind: "agents" }
  | { kind: "learning" }
  | { kind: "settings" };

// Who this app signs as. Mirrors the Rust default; RELAY_OWNER_IDENTITY overrides it there.
const ME = "sasha@mac";

// Umbrella grouping: a shared prefix becomes a sidebar SECTION rather than a nested tree. Slack has
// no sub-channels for good reasons, and 85% of this board is one Crebral program.
function group(projects: string[]) {
  const out = new Map<string, string[]>();
  for (const p of projects) {
    const key = p.includes("-") ? p.split("-")[0] : p;
    const section = projects.filter(x => x === key || x.startsWith(key + "-")).length > 1 ? key : "projects";
    if (!out.has(section)) out.set(section, []);
    out.get(section)!.push(p);
  }
  return [...out.entries()].sort((a, b) => b[1].length - a[1].length);
}

export function AppShell() {
  const [projects, setProjects] = useState<string[]>([]);
  const [active, setActive] = useState<string>("");
  const [hub, setHub] = useState<string>("");
  const [pane, setPane] = useState<Pane>({ kind: "home" });

  useEffect(() => { knownProjects().then(p => { setProjects(p); setActive(a => a || p[0] || ""); }); }, []);
  useEffect(() => { if (active) hubForProject(active).then(setHub); }, [active]);

  const client = useMemo(() => (hub ? new HubClient(hub) : null), [hub]);
  const sections = useMemo(() => group(projects), [projects]);

  // Shell-level on purpose: a notification must fire whichever pane is open, and exactly once — a
  // per-view subscription would double-notify whenever two views happened to be mounted.
  useEffect(() => {
    if (!client) return;
    return client.streamEvents(ev => { void notifyIfWorthIt(ev, ME); });
  }, [client]);

  const openProject = (p: string) => {
    if (projects.includes(p)) setActive(p);
    setPane({ kind: "project", lens: "board" });
  };

  const NavItem = ({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) => (
    <button onClick={onClick}
      className={`block w-full rounded-lg px-3 py-1.5 text-left text-[13px] ${
        on ? "bg-white/[0.07] font-medium text-[var(--color-tr-text)]"
           : "text-[var(--color-tr-muted)] hover:bg-white/[0.04] hover:text-[var(--color-tr-text)]"}`}>
      {label}
    </button>
  );

  return (
    <div className="flex h-full gap-0 bg-[var(--color-tr-bg)]">
      <aside className="flex w-60 shrink-0 flex-col px-3 py-4">
        <div className="mb-5 flex items-center gap-2.5 px-3">
          <span className="tr-dot" style={{ background: "var(--color-tr-ok)" }} />
          <span className="text-[13px] font-semibold tracking-[0.18em]">TRANTOR</span>
        </div>

        {/* FLEET — cross-project views */}
        <div className="mb-4 flex flex-col gap-0.5">
          <NavItem label="Home"     on={pane.kind === "home"}     onClick={() => setPane({ kind: "home" })} />
          <NavItem label="Inbox"    on={pane.kind === "inbox"}    onClick={() => setPane({ kind: "inbox" })} />
          <NavItem label="Agents"   on={pane.kind === "agents"}   onClick={() => setPane({ kind: "agents" })} />
          <NavItem label="Learning" on={pane.kind === "learning"} onClick={() => setPane({ kind: "learning" })} />
        </div>

        <nav className="flex-1 overflow-y-auto">
          {sections.map(([section, list]) => (
            <div key={section} className="mb-4">
              <div className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-tr-muted)]/70">{section}</div>
              <div className="flex flex-col gap-0.5">
                {list.map(p => (
                  <button key={p}
                    onClick={() => { setActive(p); setPane(cur => ({ kind: "project", lens: cur.kind === "project" ? cur.lens : "board" })); }}
                    className={`block w-full truncate rounded-lg px-3 py-1.5 text-left text-[13px] ${
                      p === active && pane.kind === "project"
                        ? "bg-white/[0.07] font-medium text-[var(--color-tr-text)]"
                        : "text-[var(--color-tr-muted)] hover:bg-white/[0.04] hover:text-[var(--color-tr-text)]"}`}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* APP — identity + settings live together */}
        <div className="mt-2 flex flex-col gap-0.5">
          <NavItem label="Settings" on={pane.kind === "settings"} onClick={() => setPane({ kind: "settings" })} />
          <div className="flex items-center gap-2.5 px-3 pt-2">
            <span className="relative flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-tr-panel)] text-[12px] font-semibold">
              {ME[0].toUpperCase()}
              <span className="tr-dot absolute -right-0.5 -bottom-0.5 border-2 border-[var(--color-tr-bg)]"
                    style={{ background: "var(--color-tr-ok)", width: 9, height: 9 }} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px]">{ME}</span>
              <span className="block truncate text-[11px] text-[var(--color-tr-muted)]">
                {hub ? hub.replace(/^https?:\/\//, "") : "resolving…"}
              </span>
            </span>
          </div>
        </div>
      </aside>

      <main className="tr-main my-2.5 mr-2.5 flex min-w-0 flex-1 flex-col overflow-hidden">
        {!client ? (
          <div className="p-10 text-sm text-[var(--color-tr-muted)]">
            No projects pinned. Run <code>trantor hub set &lt;project&gt; &lt;url&gt;</code>
          </div>
        ) : pane.kind === "home" ? <Home client={client} me={ME} onOpenProject={openProject} />
          : pane.kind === "inbox" ? <Inbox client={client} me={ME} />
          : pane.kind === "agents" ? <Agents client={client} project={active} />
          : pane.kind === "learning" ? <Learning client={client} />
          : pane.kind === "settings" ? <Settings me={ME} />
          : pane.lens === "board" ? <Board client={client} project={active} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l as Lens })} />
          : pane.lens === "chat" ? <Conversation client={client} project={active} me={ME} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l as Lens })} />
          : <Feed client={client} project={active} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l as Lens })} />}
      </main>
    </div>
  );
}
