// Shell — sidebar on the backdrop, content on a FLOATING main panel (the Buzz layout DNA).
//
// The IA is SCOPE, and the layout says so:
//   FLEET    Home, Inbox, Agents, Learning — cross-project by definition. Sidebar, top.
//   PROJECT  BOARD | FEED | CHAT — the only things that change when you pick a project.
//   APP      Settings + identity. Sidebar footer.
//
// Fleet telemetry (economics, lessons, tallies) lives on the HOME view as designed cards —
// never in chrome. The ONE exception is the balance strip (v6, #5555): a minimal row of
// per-provider chips in the header, because "is a provider about to stall mid-build" is an
// always-in-view question, not a "go look at Home" one. Chips only — the old text dump stays dead.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Bot, Eye, FolderTree, GraduationCap, House, Inbox as InboxIcon, MessagesSquare, Search, Settings as SettingsIcon } from "lucide-react";
import { appUpdateCheck, HubClient, hubForProject, knownProjects, localSessions, type AppUpdate, type Peer } from "../shared/api/client";
import { ago, stateOf } from "../shared/presence";
import { Palette, type PaletteScope } from "../features/search/Palette";
import { countUnseen, onSeenChange } from "../shared/seen";
import { usePendingProposals } from "../shared/Proposals";
import { ProjectIcon } from "../shared/ProjectIcon";
import type { Lens } from "../features/project/ProjectHeader";
import { orchestratorOpen } from "../features/workspace/herdr";

const LOCAL_HUB = "http://127.0.0.1:4477";
import { Home } from "../features/home/Home";
import { Board } from "../features/board/Board";
import { Workspace } from "../features/workspace/Workspace";
import { Review } from "../features/review/Review";
import { Feed } from "../features/feed/Feed";
import { Agents } from "../features/agents/Agents";
import { Inbox } from "../features/inbox/Inbox";
import { Messages } from "../features/messages/Messages";
import { Learning } from "../features/learning/Learning";
import { Overseer } from "../features/overseer/Overseer";
import { Settings } from "../features/settings/Settings";
import { FileTree } from "../features/files/FileTree";
import { Files } from "../features/files/Files";
import { filesColumnOpen, persistFilesColumn } from "../features/files/filesColumn";
import { Chat, type Dock } from "../features/chat/Chat";
import { Conversation } from "../features/chat/Conversation";
import { BalanceStrip } from "../features/fleet/BalanceStrip";
import { notifyIfWorthIt } from "../shared/notify";

type Pane =
  | { kind: "home" }
  | { kind: "project"; lens: Lens }
  | { kind: "inbox" }
  | { kind: "messages"; focus?: string }
  | { kind: "agents" }
  | { kind: "learning" }
  | { kind: "overseer" }
  | { kind: "settings" };

// Who this app signs as. Mirrors the Rust default; RELAY_OWNER_IDENTITY overrides it there.
const ME = "sasha@mac";

// The fleet nav, as DATA — five hand-written <NavItem> lines was how the operational half of the
// sidebar ended up typographically identical to the project half.
//
// Icons are Lucide: one stroke weight, one grid, drawn by people who draw icons. Hand-rolling six
// SVGs to save a dependency is exactly the "rabid dogs were taught how to code" failure mode, and
// the marks here do real work — they are the only thing that separates FLEET rows from PROJECT rows
// at a glance, which is the complaint this whole pass exists to answer.
const FLEET_NAV = [
  { kind: "home",     label: "Home",     Icon: House },
  { kind: "inbox",    label: "Inbox",    Icon: InboxIcon },
  { kind: "messages", label: "Messages", Icon: MessagesSquare },
  { kind: "agents",   label: "Agents",   Icon: Bot },
  { kind: "overseer", label: "Overseer", Icon: Eye },
  { kind: "learning", label: "Learning", Icon: GraduationCap },
] as const;

// Sidebar sections announce themselves. Previously the FLEET block had NO header at all, so
// "Home" and "crebral-health" were the same object rendered twice — which is why the sidebar read
// as one undifferentiated list that "just keeps going".
function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-1 pb-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.13em] text-[var(--color-tr-muted)]/60">
        {children}
      </span>
      {count !== undefined && count > 0 && (
        <span className="tr-mono text-[10px] text-[var(--color-tr-muted)]/40">{count}</span>
      )}
    </div>
  );
}

export function AppShell() {
  const [projects, setProjects] = useState<string[]>([]);
  const [active, setActive] = useState<string>("");
  const [hub, setHub] = useState<string>("");
  const [pane, setPane] = useState<Pane>({ kind: "home" });
  // Remembered, because whether you want the file tree open is a working preference, not a per-visit
  // decision. Defaults OPEN: the tree is the reason the section exists.
  const [filesOpen, setFilesOpen] = useState<boolean>(() => filesColumnOpen(localStorage));
  useEffect(() => { persistFilesColumn(localStorage, filesOpen); }, [filesOpen]);
  // Which file is open, and WHOSE copy of it. Both live here because the tree (sidebar) and the
  // viewer (main pane) are two halves of one thing: clicking in one has to land in the other.
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileSeat, setFileSeat] = useState<string | null>(null);
  // Where the orchestrator conversation sits, and whether it is showing. Remembered, because it is
  // a working preference rather than a per-visit decision — and IDEs let you choose, so this does.
  const [chatOpen, setChatOpen] = useState<boolean>(() => localStorage.getItem("trantor.chat.open") === "1");
  const [chatDock, setChatDock] = useState<Dock>(() => (localStorage.getItem("trantor.chat.dock") === "bottom" ? "bottom" : "right"));
  useEffect(() => { try { localStorage.setItem("trantor.chat.open", chatOpen ? "1" : "0"); } catch { /* private mode */ } }, [chatOpen]);
  useEffect(() => { try { localStorage.setItem("trantor.chat.dock", chatDock); } catch { /* private mode */ } }, [chatDock]);

  // Pinned projects PLUS whatever lives on the machine-local hub. A brand-new project has no
  // routing pin yet — it falls back to the local hub BY DESIGN (TDD §12.1's default), and a
  // project the app cannot see is a project that "isn't registering in Trantor at all" (the
  // crm-platform incident: a whole live crew, invisible, because only pins were listed).
  // The list is ALIVE and it only GROWS during a run: fetched at mount, refreshed every 45s,
  // merged into what we already know. Both failure modes were real within one hour: crebral-fleet
  // was born after launch (a fetch-once list never shows it), and crm-platform vanished because
  // one fetch raced a hub restart (a failed fetch must never shrink the list).
  useEffect(() => {
    let alive = true;
    // The LIST comes from known_projects alone — pinned hubs plus real checkouts. Bus traffic used
    // to be merged in too, and since sessions register with whatever string they resolved, a path
    // slug and an agent id ended up in the sidebar next to real work.
    //
    // It also REPLACES rather than accumulates. The old merge only ever added, so anything that
    // appeared once stayed for the life of the window: the list read 26 while the hub reported no
    // peers at all.
    const pull = () => knownProjects().catch((): string[] => []).then(found => {
      if (!alive) return;
      const all = [...new Set(found)].sort();
      setProjects(prev => (all.length === prev.length && all.every((v, i) => v === prev[i]) ? prev : all));
      setActive(a => (a && all.includes(a) ? a : all[0] || ""));
    });
    void pull();
    const t = setInterval(pull, 45_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  useEffect(() => { if (active) hubForProject(active).then(setHub); }, [active]);

  const client = useMemo(() => (hub ? new HubClient(hub) : null), [hub]);
  // The balance strip reads the MACHINE-LOCAL hub (balances/profile are files on this machine).
  // With no active hub yet the local one still answers, so the strip has a stable client either
  // way — it must not go dark just because no project is pinned.
  const fleetClient = useMemo(() => client ?? new HubClient(LOCAL_HUB), [client]);

  // Sidebar activity — Sasha's ruling (2026-08-13): ACTIVE means "a terminal window is open and
  // registered", and the dot BLINKS only for actual activity, never for merely sitting open.
  // Two independent truths feed it:
  //   • OPEN — a live session process on this machine (local_sessions: claude windows + crew
  //     seats). Process truth, so an idle-but-open window stays active; heartbeats ride hook
  //     fires and go dark after 5 quiet minutes, which is how crebral-health vanished from
  //     ACTIVE NOW while its window sat right there (quiet ≠ dead).
  //   • BUSY — a hub heartbeat inside the 90s work window (mid-turn NOW). Blink. Also counts as
  //     open on its own, so a busy session on ANOTHER machine (teams) still lights its row.
  // Peers still aggregate from BOTH the active hub and the machine-local hub, freshest wins.
  // #5610 v1 — Active Now carries the WHAT, not just a dot: each live row keeps the freshest
  // peer's lastSeen + model so the sidebar can say "mid-turn · 8s ago · fable" from data this
  // pull already fetched. Zero new requests; crew seats heartbeat as peers, so herdr's busy
  // panes are already counted through presence.
  type Activity = { kind: "busy" | "open"; lastSeen?: number; model?: string };
  const [activity, setActivity] = useState<Map<string, Activity>>(new Map());
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      const urls = [...new Set([hub, LOCAL_HUB].filter(Boolean))];
      const [open, ...lists] = await Promise.all([
        localSessions(),
        ...urls.map(u => new HubClient(u).peers().catch((): Peer[] => [])),
      ]);
      if (!alive) return;
      const best = new Map<string, Peer>();
      for (const ps of lists) for (const p of ps) {
        const cur = best.get(p.session);
        if (!cur || (p.lastSeen ?? 0) > (cur.lastSeen ?? 0)) best.set(p.session, p);
      }
      const m = new Map<string, Activity>();
      for (const p of open) m.set(p, { kind: "open" });
      for (const p of best.values()) {
        if (!p.project || stateOf(p) !== "busy") continue;
        const cur = m.get(p.project);
        if (cur?.kind === "busy" && (cur.lastSeen ?? 0) >= (p.lastSeen ?? 0)) continue;
        m.set(p.project, { kind: "busy", lastSeen: p.lastSeen, model: p.model || p.llm });
      }
      setActivity(m);
    };
    void pull();
    const t = setInterval(pull, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [hub]);

  // ACTIVE NOW vs the rest. This is the answer to "I have a hard time figuring out where the
  // projects are": the handful you are actually working in rise to the top, and everything else
  // stays alphabetical below so it is still a predictable place to look.
  //
  // Sorted busy-before-idle inside the active group, and the group only EXISTS when something is
  // live — an empty "Active now" header on a quiet machine would be chrome that says nothing.
  const [activeProjects, restProjects] = useMemo(() => {
    const live = projects.filter(p => activity.has(p))
      .sort((a, b) => {
        const rank = (p: string) => (activity.get(p)?.kind === "busy" ? 0 : 1);
        return rank(a) - rank(b) || a.localeCompare(b);
      });
    return [live, projects.filter(p => !activity.has(p))] as const;
  }, [projects, activity]);

  // Newer app release out? Checked at launch and every 6h — the release cadence here is days, not
  // minutes, and unauthenticated GitHub API calls are rate-limited. The chip this feeds is the
  // answer to "how does a teammate ever find out 0.3.3 is stale": before this, the app itself
  // never knew.
  // #5625 — the search palette: one component, two scopes. The trigger above every lens opens
  // it scoped to the project; ⌘K anywhere opens it global (projects + cards of the live set).
  const [palette, setPalette] = useState<PaletteScope | null>(null);
  const [focusCard, setFocusCard] = useState<number | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(cur => cur ? null : { kind: "global" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [update, setUpdate] = useState<AppUpdate | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () => appUpdateCheck().then(u => { if (alive && u) setUpdate(u); });
    void check();
    const t = setInterval(check, 6 * 60 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // How many messages are waiting for the HUMAN. Same call and same DIRECT-only filter the Inbox
  // view uses (peek, so reading the badge never advances the delivery ledger the receiving
  // session's hooks depend on). A real count or no badge at all — never a decorative dot.
  const [unread, setUnread] = useState(0);
  const directIds = useRef<number[]>([]);
  useEffect(() => {
    if (!client) return;
    let alive = true;
    // Count only what the human has NOT looked at. inbox() peeks with since=0, so it returns
    // everything ever addressed to ME; counting all of it made a lifetime total that could only
    // climb, and nothing in the app could bring it down. "Seen" is tracked locally rather than by
    // advancing the hub cursor, because that cursor belongs to the receiving session's delivery
    // hooks and peeking must never steal a message a session still has to act on.
    const pull = () => client.inbox(ME)
      .then(r => {
        if (!alive) return;
        directIds.current = (r.messages ?? []).filter(m => m.to === ME).map(m => m.id);
        setUnread(countUnseen(directIds.current));
      })
      .catch(() => {});
    void pull();
    const t = setInterval(pull, 30_000);
    const off = client.streamEvents(ev => { if (ev.type === "message") pull(); });
    // Re-count the instant a row is read, rather than waiting up to 30s for the next poll.
    const offSeen = onSeenChange(() => { if (alive) setUnread(countUnseen(directIds.current)); });
    return () => { alive = false; clearInterval(t); off(); offSeen(); };
  }, [client]);

  // How many agent proposals await the human. Badges Home (where the queue renders first) — the
  // count comes from the same shared hook every proposals surface reads, so they can't disagree.
  const pendingProposals = usePendingProposals(client).length;

  // Shell-level on purpose: a notification must fire whichever pane is open, and exactly once — a
  // per-view subscription would double-notify whenever two views happened to be mounted.
  // The presence cache feeds the offline-receiver rule (safe T3): when an agent messages a session
  // that is idle, the HUMAN gets the notification — nothing else can safely wake it.
  const lastSeenRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (!client) return;
    const pull = () => client.peers().then(ps => {
      const m = new Map<string, number>();
      for (const p of ps) m.set(p.session, p.online ? Date.now() : (p.lastSeen ?? 0));
      lastSeenRef.current = m;
    }).catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => clearInterval(t);
  }, [client]);
  useEffect(() => {
    if (!client) return;
    const isOffline = (session: string) => {
      const seen = lastSeenRef.current.get(session);
      return seen === undefined || Date.now() - seen > 5 * 60 * 1000;
    };
    return client.streamEvents(ev => { void notifyIfWorthIt(ev, ME, isOffline); });
  }, [client]);

  const openProject = (p: string) => {
    if (projects.includes(p)) setActive(p);
    setPane({ kind: "project", lens: "board" });
  };

  // WAKE — the sidebar's way to make a sleeping project live without ever leaving the app
  // (Sasha's ruling, 2026-08-31: "we want to stay away from firing up terminal sessions outside
  // of Trantor"). One call to `trantor open` via the frozen herdr bridge: it reattaches rather
  // than stacks, claims any waiting handoff with a FRESH session id, and records the pane —
  // so the click is idempotent and lands you in the Workspace lens already attached.
  const [waking, setWaking] = useState<string | null>(null);
  const [wakeErrors, setWakeErrors] = useState<Map<string, string>>(new Map());
  const wakeProject = async (p: string) => {
    if (waking) return; // one wake at a time — a second click mid-open is a re-ask, not a queue
    setWaking(p);
    setWakeErrors(prev => { const m = new Map(prev); m.delete(p); return m; });
    try {
      await orchestratorOpen(p);
      setActive(p);
      setPane({ kind: "project", lens: "workspace" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setWakeErrors(prev => new Map(prev).set(p, msg));
    } finally {
      setWaking(null);
    }
  };

  const NavItem = ({ label, Icon, on, onClick, badge, title }: {
    label: string;
    Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
    on: boolean; onClick: () => void; badge?: number; title?: string;
  }) => (
    <button onClick={onClick} title={title}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px] ${
        on ? "bg-white/[0.07] font-medium text-[var(--color-tr-text)]"
           : "text-[var(--color-tr-muted)] hover:bg-white/[0.04] hover:text-[var(--color-tr-text)]"}`}>
      <Icon size={15} strokeWidth={1.75} className="shrink-0 opacity-80" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="tr-mono shrink-0 rounded-full bg-[var(--color-tr-doing)]/20 px-1.5 text-[10px] text-[var(--color-tr-doing)]">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );

  // One project row, used by both groups so ACTIVE NOW and PROJECTS can never drift apart.
  // A div-with-role rather than a <button>, because a sleeping row carries a real WAKE button
  // inside it and interactive-inside-interactive is invalid — the row keeps its keyboard path
  // through role/tabIndex/Enter instead.
  const ProjectRow = ({ p }: { p: string }) => {
    const act = activity.get(p);
    const on = p === active && pane.kind === "project";
    const isWaking = waking === p;
    const wakeError = wakeErrors.get(p);
    const open = () => { setActive(p); setPane(cur => ({ kind: "project", lens: cur.kind === "project" ? cur.lens : "board" })); };
    // #5610 v1 — the happening-now line: a BUSY row says what is true beneath its name
    // ("mid-turn · 8s ago · fable"), from data the activity pull already holds. An open-idle
    // row stays a quiet dot; absence of the line is the idle state, never dead chrome.
    const busyLine = act?.kind === "busy"
      ? ["mid-turn", act.lastSeen ? `${ago(act.lastSeen)} ago` : null, act.model || null]
          .filter(Boolean).join(" · ")
      : null;
    return (
      <div key={p} role="button" tabIndex={0}
        onClick={open}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
        title={act?.kind === "busy" ? "a session here is mid-turn right now" : act?.kind === "open" ? "session open, idle" : undefined}
        className={`group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px] ${
          on ? "bg-white/[0.07] font-medium text-[var(--color-tr-text)]"
             : act ? "text-[var(--color-tr-text)]/85 hover:bg-white/[0.04]"
                   : "text-[var(--color-tr-muted)] hover:bg-white/[0.04] hover:text-[var(--color-tr-text)]"}`}>
        <ProjectIcon project={p} size={20} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{p}</span>
          {busyLine && (
            <span className="tr-mono block truncate text-[10px] font-normal text-[var(--color-tr-muted)]">{busyLine}</span>
          )}
          {wakeError && !isWaking && (
            <span title={wakeError} className="block truncate text-[10px] font-normal text-tr-danger">
              wake failed — click Wake to retry
            </span>
          )}
        </span>
        {/* WAKE — only a SLEEPING row offers it (no live session anywhere on the project); a live
            row's presence dot is the whole answer. Revealed on hover/focus so the sleeping list
            stays calm; while opening it stays visible and says so. `trantor open` reattaches
            rather than stacks, so the worst a stray click can do is land you in the same pane. */}
        {!act && (
          <button type="button"
            onClick={e => { e.stopPropagation(); void wakeProject(p); }}
            disabled={waking !== null && !isWaking}
            title="host this project's session as a pane and start working (reads the latest handoff + memory)"
            className={`shrink-0 rounded-[6px] bg-tr-ok/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-tr-ok hover:bg-tr-ok/20 disabled:opacity-40
              ${isWaking ? "opacity-100" : "opacity-0 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"}`}>
            {isWaking ? "Waking…" : "Wake"}
          </button>
        )}
        {/* the dot is BLUE for any open session and blinks ONLY when work is actually happening —
            a window sitting open earns presence, never motion */}
        {act && (
          <span className={`tr-dot shrink-0 ${act.kind === "busy" ? "tr-dot-pulse" : ""}`}
                style={{ background: "var(--color-tr-doing)", width: 6, height: 6 }} />
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-[var(--color-tr-bg)]">
    <div className="flex min-h-0 flex-1 gap-0">
      <aside className="flex w-60 shrink-0 flex-col px-3 py-4">
        <div className="mb-5 flex items-center gap-2.5 px-3">
          <span className="tr-dot" style={{ background: "var(--color-tr-ok)" }} />
          <span className="text-[13px] font-semibold tracking-[0.18em]">TRANTOR</span>
        </div>

        {/* FLEET — cross-project views. Labelled, so the operational half of the app announces
            itself as a different KIND of thing than the projects below it. */}
        <div className="mb-4 flex flex-col gap-0.5">
          <SectionLabel>Fleet</SectionLabel>
          {FLEET_NAV.map(({ kind, label, Icon }) => (
            <NavItem key={kind} label={label} Icon={Icon}
                     badge={kind === "inbox" ? unread : kind === "home" ? pendingProposals : undefined}
                     on={pane.kind === kind}
                     // SAFETY: every FLEET_NAV entry's `kind` is one of Pane's no-argument
                     // variants (home/inbox/messages/agents/overseer/learning) — none of them
                     // require fields beyond `kind`, so `{ kind }` alone is always a valid Pane.
                     onClick={() => setPane({ kind } as Pane)} />
          ))}
        </div>

        <nav className="flex-1 overflow-y-auto">
          {/* Inside a project, FILES is one labeled row that toggles a second column next to the
              sidebar — the tree has its own fixed-width scroll, so it no longer pushes ACTIVE NOW
              and PROJECTS down to a sliver. */}
          {pane.kind === "project" && active && (
            <div className="mb-1">
              <NavItem label="Files" Icon={FolderTree} on={filesOpen}
                       title={filesOpen ? "hide the file tree" : "show the file tree"}
                       onClick={() => setFilesOpen(o => !o)} />
            </div>
          )}
          {activeProjects.length > 0 && (
            <div className="mb-4">
              <SectionLabel count={activeProjects.length}>Active now</SectionLabel>
              <div className="flex flex-col gap-0.5">
                {activeProjects.map(p => <ProjectRow key={p} p={p} />)}
              </div>
            </div>
          )}
          {restProjects.length > 0 && (
            <div className="mb-4">
              <SectionLabel count={restProjects.length}>Projects</SectionLabel>
              <div className="flex flex-col gap-0.5">
                {restProjects.map(p => <ProjectRow key={p} p={p} />)}
              </div>
            </div>
          )}
        </nav>

        {/* APP — identity + settings live together */}
        <div className="mt-2 flex flex-col gap-0.5 border-t border-white/[0.06] pt-2">
          {update?.updateAvailable && (
            <button onClick={() => setPane({ kind: "settings" })}
              title={`Trantor ${update.latest} is out (you have ${update.current}) — install from Settings`}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px] text-[var(--color-tr-doing)] hover:bg-white/[0.04]">
              <ArrowDownToLine size={15} strokeWidth={1.75} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">Update</span>
              <span className="tr-mono shrink-0 text-[11px]">v{update.latest}</span>
            </button>
          )}
          <NavItem label="Settings" Icon={SettingsIcon} on={pane.kind === "settings"} onClick={() => setPane({ kind: "settings" })} />
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

      {/* The Files column: the project's tree, in a fixed-width scroll of its own, sitting between
          the sidebar and the content instead of pushing the project list down. Rendered only for a
          project, and only while the sidebar's Files row keeps it open. */}
      {filesOpen && pane.kind === "project" && active && (
        <div className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-white/[0.06] px-3 py-4">
          <SectionLabel>{`Files · ${active}`}</SectionLabel>
          <FileTree
            project={active}
            seat={fileSeat}
            onOpen={p => { setFilePath(p); setPane({ kind: "project", lens: "files" }); }}
          />
        </div>
      )}

      <div className={`relative my-2.5 mr-2.5 flex min-w-0 flex-1 ${chatDock === "right" ? "flex-row overflow-x-auto" : "flex-col overflow-hidden"}`}>
      <main className={`tr-main flex min-h-0 flex-1 flex-col overflow-hidden ${chatDock === "right" ? "min-w-[560px]" : "min-w-0"}`}>
        {/* #5625 — the project's search, ON TOP and lens-independent (the operator's design:
            "as long as you're in the particular project, the search bar should just be on
            top"). A trigger, not an input: the palette owns focus, results and keys. */}
        {pane.kind === "project" && active && (
          <div className="flex shrink-0 items-center px-8 pt-4">
            <button
              type="button"
              onClick={() => setPalette({ kind: "project", project: active })}
              className="tr-input flex w-full items-center gap-2.5 text-left text-[12.5px] text-[var(--color-tr-muted)]/70 hover:text-[var(--color-tr-muted)]">
              <Search size={13} strokeWidth={1.75} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">Search {active} — text, #id, @assignee</span>
              <kbd className="tr-mono shrink-0 rounded border border-[var(--color-tr-edge)] px-1.5 py-0.5 text-[10px]">⌘K everywhere</kbd>
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
        {!client ? (
          <div className="p-10 text-sm text-[var(--color-tr-muted)]">
            No projects pinned. Run <code>trantor hub set &lt;project&gt; &lt;url&gt;</code>
          </div>
        ) : pane.kind === "home" ? <Home client={client} me={ME} onOpenProject={openProject} />
          : pane.kind === "inbox" ? <Inbox client={client} me={ME} onOpenConversation={s => setPane({ kind: "messages", focus: s })} />
          : pane.kind === "messages" ? <Messages client={client} me={ME} focus={pane.focus} />
          : pane.kind === "agents" ? <Agents client={client} project={active} />
          : pane.kind === "learning" ? <Learning client={client} />
          : pane.kind === "overseer" ? <Overseer client={client} />
          : pane.kind === "settings" ? <Settings me={ME} update={update} projects={[...activeProjects, ...restProjects]} />
          : pane.lens === "workspace" ? <Workspace client={client} project={active} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l })} />
          : pane.lens === "board" ? <Board client={client} project={active} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l })} focusCard={focusCard} onFocusConsumed={() => setFocusCard(null)} />
          : pane.lens === "bus" ? <Conversation client={client} project={active} me={ME} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l })} />
          : pane.lens === "review" ? <Review client={client} project={active} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l })} />
          : pane.lens === "files" ? <Files client={client} project={active} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l })}
                                           path={filePath} seat={fileSeat} onSeat={setFileSeat} />
           : <Feed client={client} project={active} lens={pane.lens} onLens={l => setPane({ kind: "project", lens: l })} />}
        </div>
      </main>
      {/* The orchestrator conversation. Only inside a project, because it IS that project's
          session — there is no fleet-wide orchestrator to talk to. */}
      {pane.kind === "project" && active && chatOpen && (
        <Chat project={active} dock={chatDock} onDock={setChatDock} onClose={() => setChatOpen(false)} />
      )}
      {/* When it is hidden there has to be a way back, or the panel is a setting rather than a
          surface. Floating rather than in the lens bar so no lens has to know about it. */}
      {pane.kind === "project" && active && !chatOpen && (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          title="talk to this project's orchestrator"
          className="tr-card absolute bottom-5 right-5 rounded-full px-4 py-2 text-[12.5px] font-medium shadow-lg"
        >
          Orchestrator
        </button>
      )}
      </div>
    </div>
    {palette && (
      <Palette
        scope={palette}
        projects={projects}
        searchProjects={palette.kind === "project" ? [palette.project]
          : [...new Set([active, ...activeProjects])].filter(Boolean)}
        onClose={() => setPalette(null)}
        onJumpProject={p => { setActive(p); setPane({ kind: "project", lens: "board" }); }}
        onOpenCard={(p, id) => { setActive(p); setPane({ kind: "project", lens: "board" }); setFocusCard(id); }}
      />
    )}
    {/* The fleet status bar: the app's footer, to the Orca standard (#5570) — full window
        width, under everything including the sidebar. Renders null until the local hub has a
        snapshot, so a profile-less machine gets no dead chrome bar. */}
    <BalanceStrip client={fleetClient} />
    </div>
  );
}
