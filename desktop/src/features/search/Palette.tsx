// The search palette (#5625) — ONE component, two scopes, per the operator's design:
//   · project scope — the always-visible trigger above every lens: "you save space in that
//     pane and it becomes a global search bar for that particular project."
//   · global scope — ⌘K anywhere: projects by name plus cards across every known board.
// Results speak the board's own vocabulary (match.ts): text, #id, @assignee, then message,
// event and file rows from the read APIs that already exist.
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, MessageSquare, Search } from "lucide-react";
import { HubClient, hubForProject, type Card, type HubEvent } from "../../shared/api/client";
import { searchFiles } from "../files/fileApi";
import { paletteHits, type PaletteHit } from "./match";

export type PaletteScope = { kind: "global" } | { kind: "project"; project: string };
type LoadedProject = { project: string; cards: Card[]; events: HubEvent[] };
type FileSearchProject = { project: string; paths: string[] };

export function Palette({ scope, projects, searchProjects, onClose, onJumpProject, onOpenCard }: {
  scope: PaletteScope;
  /** every known project (global result rows) */
  projects: string[];
  /** the projects this palette may search when scoped; global mode uses every known project */
  searchProjects: string[];
  onClose: () => void;
  onJumpProject: (p: string) => void;
  onOpenCard: (project: string, id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [cards, setCards] = useState<Record<string, Card[]>>({});
  const [messages, setMessages] = useState<Record<string, HubEvent[]>>({});
  const [events, setEvents] = useState<Record<string, HubEvent[]>>({});
  const [files, setFiles] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const targetProjectKey = (scope.kind === "global" ? projects : searchProjects).join("\u0000");
  const targetProjects = useMemo(
    () => scope.kind === "global" ? projects : searchProjects,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.kind, targetProjectKey],
  );

  // Cards and recent bus rows load ONCE per open, per project — the palette filters in memory from
  // there. File search is query-bound because the existing file API is already bounded by query.
  useEffect(() => {
    let alive = true;
    inputRef.current?.focus();
    setLoading(true);
    void (async () => {
      const loaded = await Promise.all(targetProjects.map(async p => {
        try {
          const hub = await hubForProject(p);
          const client = new HubClient(hub);
          const [taskRows, eventRows] = await Promise.all([
            client.tasks(p),
            client.events({ project: p, limit: 500 }).then(r => r.events ?? []),
          ]);
          return { project: p, cards: taskRows, events: eventRows };
        } catch {
          const empty: LoadedProject = { project: p, cards: [], events: [] };
          return empty;
        }
      }));
      if (!alive) return;
      setCards(Object.fromEntries(loaded.map(row => [row.project, row.cards])));
      setEvents(Object.fromEntries(loaded.map(row => [row.project, row.events])));
      setMessages(Object.fromEntries(loaded.map(row => [row.project, row.events.filter(e => e.type === "message")])));
      setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetProjects.join("\u0000")]);

  useEffect(() => {
    let alive = true;
    const q = query.trim();
    if (!q || q.startsWith("#") || q.startsWith("@")) {
      setFiles({});
      return () => { alive = false; };
    }
    void (async () => {
      const loaded = await Promise.all(targetProjects.map(async p => {
        try { return { project: p, paths: await searchFiles(p, q) }; }
        catch {
          const empty: FileSearchProject = { project: p, paths: [] };
          return empty;
        }
      }));
      if (alive) setFiles(Object.fromEntries(loaded.map(row => [row.project, row.paths])));
    })();
    return () => { alive = false; };
  }, [query, targetProjectKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const hits = useMemo<PaletteHit[]>(
    () => paletteHits(query, projects, cards, { includeProjects: scope.kind === "global" }, { messagesByProject: messages, eventsByProject: events, filesByProject: files }),
    [query, projects, cards, messages, events, files, scope.kind],
  );
  useEffect(() => { setSel(0); }, [query]);

  const pick = (h: PaletteHit) => {
    if (h.kind === "project") onJumpProject(h.project);
    else if (h.kind === "card") onOpenCard(h.project, h.card.id);
    else if (h.kind === "message" || h.kind === "event") {
      if (h.cardId !== null) onOpenCard(h.project, h.cardId);
      else onJumpProject(h.project);
    }
    else onJumpProject(h.project);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(s + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === "Enter" && hits[sel]) { e.preventDefault(); pick(hits[sel]); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
         onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tr-card w-[560px] max-w-[calc(100vw-48px)] overflow-hidden p-0 shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-[var(--color-tr-edge)] px-4 py-3">
          <Search size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-tr-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={scope.kind === "global"
              ? "Search everywhere — projects, cards, messages, events, files"
              : `Search ${scope.project} — text, #id, @assignee`}
            className="w-full bg-transparent text-[13.5px] outline-none placeholder:text-[var(--color-tr-muted)]/60"
          />
          <kbd className="tr-mono shrink-0 rounded border border-[var(--color-tr-edge)] px-1.5 py-0.5 text-[10px] text-[var(--color-tr-muted)]">esc</kbd>
        </div>
        <div className="max-h-[46vh] overflow-y-auto py-1.5">
          {hits.length === 0 && !loading && (
            <div className="px-4 py-3 text-[12.5px] text-[var(--color-tr-muted)]">
              {query.trim() ? "Nothing matches." : "Type to search."}
            </div>
          )}
          {loading && hits.length === 0 && (
            <div className="px-4 py-3 text-[12.5px] text-[var(--color-tr-muted)]">Loading search index…</div>
          )}
          {hits.map((h, i) => (
            <button
              key={hitKey(h)}
              onClick={() => pick(h)}
              onMouseEnter={() => setSel(i)}
              className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-[12.5px] ${i === sel ? "bg-white/[0.06]" : ""}`}>
              {renderHit(h, scope)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function hitKey(h: PaletteHit): string {
  if (h.kind === "project") return `p:${h.project}`;
  if (h.kind === "card") return `c:${h.project}:${h.card.id}`;
  if (h.kind === "message") return `m:${h.project}:${h.event.id ?? h.event.ts}`;
  if (h.kind === "event") return `e:${h.project}:${h.event.id ?? h.event.ts}:${h.event.type}`;
  return `f:${h.project}:${h.path}`;
}

function renderHit(h: PaletteHit, scope: PaletteScope) {
  if (h.kind === "project") return (
    <>
      <span className="tr-chip shrink-0">project</span>
      <span className="min-w-0 truncate">{h.project}</span>
    </>
  );
  if (h.kind === "card") return (
    <>
      <span className="tr-mono shrink-0 text-[11px] text-[var(--color-tr-muted)]">#{h.card.id}</span>
      <span className="min-w-0 flex-1 truncate">{h.card.title}</span>
      <span className="tr-chip shrink-0">{h.card.status}</span>
      {scope.kind === "global" && <span className="tr-mono shrink-0 text-[10.5px] text-[var(--color-tr-muted)]">{h.project}</span>}
    </>
  );
  if (h.kind === "message") return (
    <>
      <MessageSquare size={13} strokeWidth={1.75} className="shrink-0 text-[var(--color-tr-muted)]" />
      <span className="tr-chip shrink-0">message</span>
      <span className="min-w-0 flex-1 truncate">{h.event.text}</span>
      <span className="tr-mono shrink-0 text-[10.5px] text-[var(--color-tr-muted)]">{h.project}</span>
    </>
  );
  if (h.kind === "event") return (
    <>
      <span className="tr-chip shrink-0">{h.event.type}</span>
      <span className="min-w-0 flex-1 truncate">{h.label}</span>
      <span className="tr-mono shrink-0 text-[10.5px] text-[var(--color-tr-muted)]">{h.project}</span>
    </>
  );
  return (
    <>
      <FileText size={13} strokeWidth={1.75} className="shrink-0 text-[var(--color-tr-muted)]" />
      <span className="tr-chip shrink-0">file</span>
      <span className="min-w-0 flex-1 truncate">{h.path}</span>
      <span className="tr-mono shrink-0 text-[10.5px] text-[var(--color-tr-muted)]">{h.project}</span>
    </>
  );
}
