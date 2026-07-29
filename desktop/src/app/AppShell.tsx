// Shell: sidebar + main. The IA is Buzz's (projects list on the left, content on the right) — layout,
// not code, so nothing Apache-licensed comes across into this MIT repo.
import { useEffect, useMemo, useState } from "react";
import { HubClient, hubForProject, knownProjects } from "../shared/api/client";
import { Board } from "../features/board/Board";
import { Feed } from "../features/feed/Feed";

// Umbrella grouping: a project prefix becomes a sidebar SECTION rather than a nested tree. Slack has
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

type Lens = "board" | "feed";

export function AppShell() {
  const [lens, setLens] = useState<Lens>("board");
  const [projects, setProjects] = useState<string[]>([]);
  const [active, setActive] = useState<string>("");
  const [hub, setHub] = useState<string>("");

  useEffect(() => { knownProjects().then(p => { setProjects(p); setActive(a => a || p[0] || ""); }); }, []);
  useEffect(() => { if (active) hubForProject(active).then(setHub); }, [active]);

  const client = useMemo(() => (hub ? new HubClient(hub) : null), [hub]);
  const sections = useMemo(() => group(projects), [projects]);

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-tr-edge)] bg-[var(--color-tr-panel)]">
        <div className="px-4 py-3 text-sm font-semibold tracking-wide">trantor</div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {sections.map(([section, list]) => (
            <div key={section} className="mb-3">
              <div className="px-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--color-tr-muted)]">{section}</div>
              {list.map(p => (
                <button key={p} onClick={() => setActive(p)}
                  className={`block w-full truncate rounded px-2 py-1 text-left text-sm ${
                    p === active ? "bg-black/40 text-[var(--color-tr-text)]" : "text-[var(--color-tr-muted)] hover:bg-black/20"}`}>
                  {p}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-[var(--color-tr-edge)] px-4 py-2 text-[10px] text-[var(--color-tr-muted)]">
          {hub ? hub.replace(/^https?:\/\//, "") : "resolving hub…"}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex gap-1 border-b border-[var(--color-tr-edge)] px-4 py-2">
          {(["board", "feed"] as Lens[]).map(l => (
            <button key={l} onClick={() => setLens(l)}
              className={`rounded px-3 py-1 text-xs uppercase tracking-wide ${
                lens === l ? "bg-black/40 text-[var(--color-tr-text)]" : "text-[var(--color-tr-muted)] hover:bg-black/20"}`}>
              {l}
            </button>
          ))}
        </div>
        {client && active
          ? (lens === "board"
              ? <Board client={client} project={active} />
              : <Feed client={client} project={active} />)
          : <div className="p-6 text-sm text-[var(--color-tr-muted)]">No projects pinned. Run: trantor hub set &lt;project&gt; &lt;url&gt;</div>}
      </main>
    </div>
  );
}
