// The ONE right mode pane (#5841, per .scratch/design-v4/*.dc.html): Files | Git | Sessions |
// Chat. This pane REPLACES three older surfaces — the chat dock, the left tree column, and the
// in-lens SCM rail — by MOVING their pieces here, not duplicating them: the tree is the same
// FileTree, the Git mode is the same GitPanel, the Chat tab is the same Chat component, and the
// note composer is the one that used to ride the SCM rail. The center editor keeps v3 whole and
// narrows, never disappears (ChatFocused.dc.html).
//
// Mode widths follow the artboards: 300 for Files/Git/Sessions, 440 for Chat. The seat scope
// selector lives at the BOTTOM of the pane (Main.dc.html:147-152) and feeds tree, editor, and
// git alike — one picker, three consumers.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FolderTree, GitBranch, History, MessageSquare } from "lucide-react";
import type { Card, HubClient, Peer } from "../../shared/api/client";
import { BrandGlyph } from "../../shared/Avatar";
import { GitPanel } from "./GitPanel";
import { Chat } from "../chat/Chat";
import { folderSeats, mergeChanges, mergedCountFor, projectChanges, type ProjectChangeRow } from "./gitApi";
import { FileTree } from "./FileTree";
import { SessionsMode } from "./SessionsMode";
import { tabsMode, type TabsMode } from "./tabStrip";
import type { SessionRow } from "./sessionsApi";

type Mode = "files" | "git" | "sessions" | "chat";

const seatName = (session: string) => session.split(":")[0];

/** "…/features/code/Files.tsx" — the CHANGED rows truncate from the LEFT, the way the artboard
 *  does it (Main.dc.html:113): what you recognize in a changed file is the end of the path. */
const tailPath = (p: string, max = 26): string => {
  if (p.length <= max) return p;
  const cut = p.slice(-(max - 1));
  const slash = cut.indexOf("/");
  return slash > -1 ? `…/${cut.slice(slash + 1)}` : `…${cut}`;
};

export function ModePane({ client, project, seat, onSeat, onOpenFile }: {
  client: HubClient;
  project: string;
  seat: string | null;
  onSeat: (s: string | null) => void;
  /** The SAME open call the tree uses — a CHANGED or SCM row lands in the editable Changes view. */
  onOpenFile: (path: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("files");
  const [scopeOpen, setScopeOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [tasks, setTasks] = useState<Card[]>([]);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<"ok" | "fail" | null>(null);
  const [selectedClaude, setSelectedClaude] = useState<SessionRow | null>(null);

  // The tab strip's measured layout (#6036): a tab word NEVER truncates, so the strip compares
  // the natural width of its four full labels (an offscreen twin at the strip's own font)
  // against the width the strip really has, and renders icon-only only when the labels would
  // not fit. The observers watch the elements whose width actually changes — the strip AND the
  // pane root it fills — never the absolute twin, whose intrinsic width would lie. Unmeasured
  // stays on labels: the designed default never degrades on a guess.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState<{ labels: number | null; strip: number | null }>({ labels: null, strip: null });
  const [tabs, setTabs] = useState<TabsMode>("labels");
  useEffect(() => {
    const pane = paneRef.current;
    const strip = stripRef.current;
    const twin = measureRef.current;
    if (!pane || !strip) return;
    const measureNow = () => setDims({
      labels: twin ? twin.getBoundingClientRect().width : null,
      strip: Math.min(strip.clientWidth, pane.clientWidth),
    });
    measureNow();
    if (!("ResizeObserver" in globalThis)) return;
    const ro = new ResizeObserver(() => measureNow());
    ro.observe(pane);
    ro.observe(strip);
    // Font loading and pane drags outside the flex layout change the labels' truth without a
    // strip resize; re-measure on those too. happy-dom ignores both — tests drive measureNow
    // through the resize event instead.
    const onResize = () => measureNow();
    window.addEventListener("resize", onResize);
    document.fonts?.ready.then(onResize).catch(() => {});
    return () => { ro.disconnect(); window.removeEventListener("resize", onResize); };
  }, []);
  useEffect(() => {
    const next = tabsMode(dims.labels, dims.strip, tabs);
    if (next !== tabs) setTabs(next);
  }, [dims, tabs]);
  const compactTabs = tabs === "icons";

  // The seats of this project — the footer's scope chips. Same peers poll every lens runs.
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { client.peers().then(p => { if (alive) setPeers(p); }).catch(() => {}); };
    load();
    const iv = setInterval(load, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [client]);

  // The PROJECT-WIDE change snapshot (#5959): one command covers the checkout and every seat
  // worktree, replacing the per-seat seatDiff fan-out. Polled at the SCM cadence; a failed read
  // stays absent — clean and unknown must not look different in a scary way.
  const [changeRows, setChangeRows] = useState<ProjectChangeRow[]>([]);
  useEffect(() => {
    let alive = true;
    const pull = () => projectChanges(project)
      .then(rows => { if (alive) setChangeRows(rows); })
      .catch(() => { if (alive) setChangeRows([]); });
    pull();
    const iv = setInterval(pull, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [project]);

  // The union the CHANGED section and the tree render from.
  const merged = useMemo(() => mergeChanges(changeRows), [changeRows]);
  const folderMarks = useMemo(() => folderSeats(merged), [merged]);

  // Changed-file count per seat, for the footer chips: the one-click answer to "which worktree
  // has edits" (2026-09-01). Absent = clean, never a zero.
  const seats = useMemo(
    () => peers.filter(p => p.session.endsWith(`:${project}`) && !p.session.toLowerCase().startsWith("macbook")),
    [peers, project],
  );
  const seatCount = (name: string) => changeRows.filter(r => r.seat === name).length;

  // The note composer refs the seat's in-flight card, so a note lands as "#id <note>" exactly
  // like every other card reference the seat already reads. Moved from the SCM rail (#5810).
  useEffect(() => {
    let alive = true;
    const pull = () => { client.tasks(project).then(t => { if (alive) setTasks(t); }).catch(() => {}); };
    pull();
    const iv = setInterval(pull, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [client, project]);
  const seatCard = useMemo(() => {
    if (!seat) return undefined;
    return tasks.find(t => (t.status === "doing" || t.status === "testing") && t.assignee === `${seat}:${project}`);
  }, [tasks, seat, project]);

  const sendNote = async () => {
    const text = note.trim();
    if (!seat || !text || sending) return;
    setSending(true);
    try {
      await client.send(`${seat}:${project}`, (seatCard ? `#${seatCard.id} ` : "") + text, project);
      setNote("");
      setSent("ok");
    } catch {
      setSent("fail");
    } finally {
      setSending(false);
    }
  };

  // CHANGED rows: the UNION across the checkout and every seat (#5959), each row carrying the
  // seats that touched it. A row with exactly one writer opens that copy directly; a contested
  // path first asks whose copy — the chooser lives in the row until picked.
  const changedRows = useMemo(() => {
    const f = filter.toLowerCase();
    const rows = f ? merged.filter(e => e.path.toLowerCase().includes(f)) : merged;
    return rows;
  }, [merged, filter]);
  const [chooserFor, setChooserFor] = useState<string | null>(null);
  const openChanged = (path: string, seats: (string | null)[]) => {
    const writers = seats.filter((s): s is string => s !== null);
    if (writers.length === 1) {
      onSeat(writers[0]);
      onOpenFile(path);
      setChooserFor(null);
      return;
    }
    if (writers.length === 0) {
      onSeat(null);
      onOpenFile(path);
      setChooserFor(null);
      return;
    }
    // contested: flip the row's inline chooser instead of guessing
    setChooserFor(current => (current === path ? null : path));
  };

  // The rail is the SAME object as the lens tabs (tr-seg + a raised active segment) with a
  // Lucide icon per mode, so it reads as clickable by association with every other tab in the
  // app. The four segments share the width EXACTLY (grid quarters, #5960): the Chat segment's
  // live dot used to push the row past the 300px rail. A label never truncates (#6036): when
  // the measured labels would not fit the strip steps down to icon-only (title carries the
  // word); the truncate class below is the last-resort guard for the gap zone, not the design.
  const modeBtn = (m: Mode, label: string, Icon: typeof FolderTree, dot?: boolean) => (
    <button
      type="button"
      onClick={() => {
        if (m === "chat") setSelectedClaude(null);
        setMode(m);
      }}
      data-on={mode === m}
      title={label}
      aria-label={label}
      className="flex w-full min-w-0 items-center justify-center gap-1 rounded-[7px] px-1 py-[5px] text-[11.5px] text-tr-muted data-[on=true]:bg-white/[0.07] data-[on=true]:font-medium data-[on=true]:text-tr-text"
    >
      <Icon size={12} strokeWidth={1.75} className="shrink-0" />
      {!compactTabs && <span className="min-w-0 truncate">{label}</span>}
      {dot && <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-tr-doing" />}
    </button>
  );

  // One truth for the real tabs and the offscreen twin alike — the twin measures what the four
  // LABELED tabs need, so it must share their icon, label, dot, font, and padding verbatim.
  const MODES: { m: Mode; label: string; Icon: typeof FolderTree; dot?: boolean }[] = [
    { m: "files", label: "Files", Icon: FolderTree },
    { m: "git", label: "Git", Icon: GitBranch },
    { m: "sessions", label: "Sessions", Icon: History },
    { m: "chat", label: "Chat", Icon: MessageSquare, dot: true },
  ];

  return (
    <div
      ref={paneRef}
      className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-[12px] border border-tr-edge bg-tr-main"
      style={{ width: mode === "chat" ? 440 : 300, margin: 12 }}
    >
      {/* mode rail — exact quarters at 300px and 440px alike (#5960); icon-only below the
          measured label-fit width so a tab word never truncates (#6036). The offscreen twin
          renders the four LABELED tabs shrink-wrapped and invisible: its width is the truth of
          what the labels need — the real grid quarters truncate, so they cannot be asked. */}
      <div ref={stripRef} className="tr-seg relative grid shrink-0 grid-cols-4 gap-px border-b border-tr-edge px-2 py-2">
        <div
          ref={measureRef}
          aria-hidden
          className="pointer-events-none absolute flex gap-px whitespace-nowrap px-2"
          style={{ visibility: "hidden" }}
        >
          {MODES.map(({ m, label, Icon, dot }) => (
            <span key={m} className="flex items-center gap-1 whitespace-nowrap rounded-[7px] px-1 py-[5px] text-[11.5px]">
              <Icon size={12} strokeWidth={1.75} className="shrink-0" />
              <span className="whitespace-nowrap">{label}</span>
              {dot && <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-tr-doing" />}
            </span>
          ))}
        </div>
        {MODES.map(({ m, label, Icon, dot }) => modeBtn(m, label, Icon, dot))}
      </div>

      {/* FILES — find box, CHANGED pinned first, ALL FILES tree, seat footer */}
      {mode === "files" && (
        <>
          <div className="px-3 pt-2.5 pb-1.5">
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Find files…"
              className="w-full rounded-[8px] border border-tr-edge bg-transparent px-2.5 py-[6px] text-[12px] text-tr-text outline-none placeholder:text-tr-muted/60 focus:border-tr-doing/50"
            />
          </div>
          <div className="px-3 pt-1 pb-0.5 text-[9px] font-semibold tracking-[0.13em] text-tr-muted/60">
            CHANGED · all sources
          </div>
          <div className="max-h-[220px] shrink-0 overflow-y-auto px-1.5">
            {changedRows.length === 0 && (
              <div className="px-2 py-1 text-[11.5px] text-tr-muted/70">
                {changeRows.length === 0 || merged.length === 0 ? "Clean — no changes anywhere." : "reading…"}
              </div>
            )}
            {changedRows.map(e => (
              <div key={e.path} className="mb-0.5">
                <button
                  type="button"
                  onClick={() => openChanged(e.path, e.seats)}
                  title={`${e.path} — open the editable diff in its writer's worktree`}
                  className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1 text-left hover:bg-white/[0.05]"
                >
                  <span className="tr-mono min-w-0 flex-1 truncate text-[11.5px] text-tr-muted">{tailPath(e.path)}</span>
                  {e.status === "??" && <span className="tr-mono shrink-0 text-[10px] text-tr-warn">new</span>}
                  {(() => {
                    const n = mergedCountFor(merged, e.path);
                    return n ? (
                      <span className="tr-mono shrink-0 text-[10px] tabular-nums">
                        <span style={{ color: "var(--git-decoration-added)" }}>+{n.plus}</span>
                        <span style={{ color: "var(--git-decoration-deleted)" }}>−{n.minus}</span>
                      </span>
                    ) : null;
                  })()}
                  {e.seats.filter((s): s is string => s !== null).map(s => (
                    <BrandGlyph key={s} name={s} size={11} />
                  ))}
                </button>
                {chooserFor === e.path && e.seats.filter((s): s is string => s !== null).length > 1 && (
                  <div className="ml-4 flex flex-wrap gap-1 rounded-[7px] border border-tr-edge bg-tr-panel/60 px-2 py-1">
                    <span className="py-0.5 text-[10.5px] text-tr-muted/70">whose copy?</span>
                    {e.seats.filter((s): s is string => s !== null).map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => { onSeat(s); onOpenFile(e.path); setChooserFor(null); }}
                        className="tr-chip hover:text-tr-text"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="px-3 pb-0.5 pt-3 text-[9px] font-semibold tracking-[0.13em] text-tr-muted/60">ALL FILES</div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-1">
            <FileTree
              project={project}
              seat={seat}
              openPath={null}
              onOpen={p => onOpenFile(p)}
              marks={{ entries: merged, folders: folderMarks }}
            />
          </div>
        </>
      )}

      {/* GIT — Orca's source-control anatomy: PR affordance, message, stage all, changes, commits,
          and the note to the seat at the bottom (SourceControl.dc.html). */}
      {mode === "git" && (
        <>
          {!seat ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4">
              <div className="tr-card-ghost px-4 py-4 text-center text-[12px] leading-relaxed">
                Git mode works on a seat's worktree — pick one at the bottom.
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
                <button
                  type="button"
                  disabled
                  title="v4.1 — PR creation rides the GitHub wave"
                  className="rounded-[7px] border border-tr-edge px-3 py-1 text-[12px] font-medium text-tr-text disabled:opacity-50"
                >
                  Create PR
                </button>
                <span className="tr-mono text-[11px] text-tr-muted">seat/{seat} → main</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <GitPanel project={project} seat={seat} onOpenFile={onOpenFile} />
              </div>
              <div className="shrink-0 border-t border-tr-edge px-3 py-2.5">
                <div className="flex items-center gap-2 px-0.5 pb-1">
                  <span className="text-[11px] font-medium text-tr-muted">note to {seat}</span>
                  {seatCard && <span className="tr-mono text-[10px] text-tr-muted/70">#{seatCard.id}</span>}
                  {sent === "ok" && <span className="tr-chip ml-auto shrink-0">sent</span>}
                  {sent === "fail" && <span className="tr-chip ml-auto shrink-0" style={{ color: "var(--color-tr-fail)" }}>failed</span>}
                </div>
                <textarea
                  value={note}
                  onChange={e => { setNote(e.target.value); setSent(null); }}
                  rows={2}
                  placeholder={`Tell ${seat} what to change…`}
                  className="w-full resize-none rounded-[8px] border border-tr-edge bg-transparent px-2.5 py-1.5 text-[12px] outline-none placeholder:text-tr-muted/60 focus:border-tr-doing/50"
                />
                <button
                  type="button"
                  onClick={() => { void sendNote(); }}
                  disabled={!note.trim() || sending}
                  className="mt-1 w-full rounded-[8px] border border-tr-edge py-1 text-[12px] font-medium text-tr-text disabled:opacity-40"
                >
                  {sending ? "Sending…" : "Send note"}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* SESSIONS — one history assembled from each harness's own on-disk store. */}
      {mode === "sessions" && (
        <SessionsMode project={project} onOpenClaude={session => {
          setSelectedClaude(session);
          setMode("chat");
        }} />
      )}

      {/* CHAT — the orchestrator conversation, moved whole from the old dock. The editor
          narrows, never disappears (ChatFocused.dc.html). */}
      {mode === "chat" && (
        <Chat
          project={project}
          sessionId={selectedClaude?.id}
          dock="pane"
          onDock={() => {}}
          onClose={() => {
            setMode(selectedClaude ? "sessions" : "files");
            setSelectedClaude(null);
          }}
        />
      )}

      {/* seat scope selector — the bottom of the pane, one picker for tree, editor, and git */}
      {/* The scope picker — ONE dropdown, Files and Git only (2026-09-01: six wrapping chips in
          a 300px footer read as broken, and a seat picker under the chat composer scoped nothing).
          The raised face says which copy the tree, editor, and git are reading; the menu lists
          the project checkout and every seat with its changed-file count. */}
      {(mode === "files" || mode === "git") && (
        <div className="relative shrink-0 border-t border-tr-edge px-3 py-2">
          <button
            type="button"
            onClick={() => setScopeOpen(o => !o)}
            title="Which checkout the tree, editor, and git read"
            className="flex w-full items-center gap-2 rounded-[8px] border border-tr-edge bg-white/[0.03] px-2.5 py-[6px] text-[12px] text-tr-text hover:bg-white/[0.05]"
          >
            <span className="text-[10.5px] text-tr-muted">scope</span>
            <span className="tr-mono min-w-0 flex-1 truncate text-left text-[11.5px]">
              {seat ? `seat/${seat}` : "project"}
            </span>
            {seat && seatCount(seat) > 0 && (
              <span className="tr-mono shrink-0 text-[10.5px] text-tr-doing">{seatCount(seat)} changed</span>
            )}
            <ChevronDown size={11} strokeWidth={2.5} className="shrink-0 text-tr-muted" />
          </button>
          {scopeOpen && (
            <div className="absolute bottom-full left-3 right-3 z-10 mb-1 overflow-hidden rounded-lg border border-tr-edge bg-tr-panel shadow-lg">
              <button
                type="button"
                onClick={() => { onSeat(null); setScopeOpen(false); }}
                data-on={seat === null}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-tr-muted hover:bg-white/[0.05] hover:text-tr-text data-[on=true]:text-tr-text"
              >
                <span className="tr-mono flex-1">project</span>
                <span className="text-[10.5px] text-tr-muted/70">the checkout</span>
              </button>
              {seats.map(s => {
                const name = seatName(s.session);
                const n = seatCount(name);
                return (
                  <button
                    key={s.session}
                    type="button"
                    onClick={() => { onSeat(name); setScopeOpen(false); }}
                    data-on={seat === name}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-tr-muted hover:bg-white/[0.05] hover:text-tr-text data-[on=true]:text-tr-text"
                  >
                    <span className="tr-mono flex-1">seat/{name}</span>
                    {n > 0
                      ? <span className="tr-mono text-[10.5px] text-tr-doing">{n} changed</span>
                      : <span className="text-[10.5px] text-tr-muted/70">clean</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
