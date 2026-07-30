// Shell — sidebar + main.
//
// The first cut got the IA wrong by stacking everything into one tab strip. The distinction the app
// actually has is SCOPE, and the layout should say so:
//
//   GLOBAL   Inbox and Agents are not properties of a project. Messages are addressed to YOU, and a
//            seat busy on ANOTHER project is exactly what you need to see. Sidebar, above the
//            project list — where Buzz puts them, and for the same reason.
//   APP      Settings belongs beside the identity it configures. Sidebar footer.
//   PROJECT  BOARD and FEED are two LENSES on one project, and the only things that belong in the
//            main pane's tab strip — because they are the only things that change when you pick a
//            different project.
//
// Putting a global view in a per-project tab strip implies it is scoped to that project. It is not.
import { useEffect, useMemo, useState } from "react";
import { HubClient, hubForProject, knownProjects } from "../shared/api/client";
import { Board } from "../features/board/Board";
import { Feed } from "../features/feed/Feed";
import { Agents } from "../features/agents/Agents";
import { Inbox } from "../features/inbox/Inbox";
import { Settings } from "../features/settings/Settings";
import { Conversation } from "../features/chat/Conversation";
import { notifyIfWorthIt } from "../shared/notify";

type Lens = "board" | "feed" | "chat";
type Pane =
  | { kind: "project"; lens: Lens }
  | { kind: "inbox" }
  | { kind: "agents" }
  | { kind: "settings" };

// Who this app signs as. Mirrors the Rust default; RELAY_OWNER_IDENTITY overrides it there.
const ME = "sasha@mac";

// Umbrella grouping: a shared prefix becomes a sidebar SECTION rather than a nested tree. Slack has
// no sub-channels for good reasons, and 85% of this board is one Crebral program.
function group(projects: string[]) {
  const out = new Map<string, string[]>();
  for (const p of projects) {
    const key = p.includes("-") ? p.split("-")[0] : p;
    const section = projects.filter(x => x === key || x.startsWith(key + "-")).length > 1 ? key : "other";
    if (!out.has(section)) out.set(section, []);
    out.get(section)!.push(p);
  }
  return [...out.entries()].sort((a, b) => b[1].length - a[1].length);
}

export function AppShell() {
  const [projects, setProjects] = useState<string[]>([]);
  const [active, setActive] = useState<string>("");
  const [hub, setHub] = useState<string>("");
  const [pane, setPane] = useState<Pane>({ kind: "project", lens: "board" });

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

  const NavItem = ({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) => (
    <button onClick={onClick}
      className={`block w-full rounded px-2 py-1 text-left text-sm ${
        on ? "bg-black/40 text-[var(--color-tr-text)]" : "text-[var(--color-tr-muted)] hover:bg-black/20"}`}>
      {label}
    </button>
  );

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-tr-edge)] bg-[var(--color-tr-panel)]">
        <div className="px-4 py-3 text-sm font-semibold tracking-wide">trantor</div>

        {/* GLOBAL — not scoped to the selected project */}
        <div className="px-2 pb-2">
          <NavItem label="Inbox"  on={pane.kind === "inbox"}  onClick={() => setPane({ kind: "inbox" })} />
          <NavItem label="Agents" on={pane.kind === "agents"} onClick={() => setPane({ kind: "agents" })} />
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {sections.map(([section, list]) => (
            <div key={section} className="mb-3">
              <div className="px-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--color-tr-muted)]">{section}</div>
              {list.map(p => (
                <button key={p}
                  onClick={() => {
                    setActive(p);
                    setPane(cur => ({ kind: "project", lens: cur.kind === "project" ? cur.lens : "board" }));
                  }}
                  className={`block w-full truncate rounded px-2 py-1 text-left text-sm ${
                    p === active && pane.kind === "project"
                      ? "bg-black/40 text-[var(--color-tr-text)]"
                      : "text-[var(--color-tr-muted)] hover:bg-black/20"}`}>
                  {p}
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* APP — settings sits with the identity it configures */}
        <div className="border-t border-[var(--color-tr-edge)] px-2 py-2">
          <NavItem label="Settings" on={pane.kind === "settings"} onClick={() => setPane({ kind: "settings" })} />
          <div className="truncate px-2 pt-1 text-[10px] text-[var(--color-tr-muted)]">
            {ME} · {hub ? hub.replace(/^https?:\/\//, "") : "resolving…"}
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {/* Lens tabs belong to the PROJECT pane only — they are meaningless for a global view. */}
        {pane.kind === "project" && (
          <div className="flex items-center gap-1 border-b border-[var(--color-tr-edge)] px-4 py-2">
            {(["board", "feed", "chat"] as Lens[]).map(l => (
              <button key={l} onClick={() => setPane({ kind: "project", lens: l })}
                className={`rounded px-3 py-1 text-xs uppercase tracking-wide ${
                  pane.lens === l ? "bg-black/40 text-[var(--color-tr-text)]" : "text-[var(--color-tr-muted)] hover:bg-black/20"}`}>
                {l}
              </button>
            ))}
            <span className="ml-3 text-xs text-[var(--color-tr-muted)]">{active}</span>
          </div>
        )}

        {!client ? (
          <div className="p-6 text-sm text-[var(--color-tr-muted)]">
            No projects pinned. Run <code>trantor hub set &lt;project&gt; &lt;url&gt;</code>
          </div>
        ) : pane.kind === "inbox" ? <Inbox client={client} me={ME} />
          : pane.kind === "agents" ? <Agents client={client} project={active} />
          : pane.kind === "settings" ? <Settings me={ME} />
          : pane.lens === "board" ? <Board client={client} project={active} />
          : pane.lens === "chat" ? <Conversation client={client} project={active} me={ME} />
          : <Feed client={client} project={active} />}
      </main>
    </div>
  );
}
