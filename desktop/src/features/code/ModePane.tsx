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
import { useEffect, useMemo, useState } from "react";
import type { Card, HubClient, Peer } from "../../shared/api/client";
import { FileTree } from "./FileTree";
import { GitPanel } from "./GitPanel";
import { Chat } from "../chat/Chat";
import { gitPanel, lineCountFor, type GitPanelSnapshot } from "./gitApi";
import { seatDiff } from "./seatDiff";

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
  const [filter, setFilter] = useState("");
  const [changed, setChanged] = useState<GitPanelSnapshot | null>(null);
  const [seatCounts, setSeatCounts] = useState<Record<string, number>>({});
  const [tasks, setTasks] = useState<Card[]>([]);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<"ok" | "fail" | null>(null);

  // The seats of this project — the footer's scope chips. Same peers poll every lens runs.
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { client.peers().then(p => { if (alive) setPeers(p); }).catch(() => {}); };
    load();
    const iv = setInterval(load, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [client]);

  // CHANGED (Files mode) and the git panel read the same snapshot; polled at the SCM cadence.
  // A failed read stays absent — clean and unknown must not look different in a scary way.
  useEffect(() => {
    if (!seat) { setChanged(null); return; }
    let alive = true;
    const pull = () => gitPanel(project, seat)
      .then(s => { if (alive) setChanged(s); })
      .catch(() => { if (alive) setChanged(null); });
    pull();
    const iv = setInterval(pull, 12_000);
    return () => { alive = false; clearInterval(iv); };
  }, [client, project, seat]);

  // Changed-file count per seat, for the footer chips: the one-click answer to "which worktree
  // has edits" (2026-09-01). Absent = clean, never a zero.
  const seats = useMemo(
    () => peers.filter(p => p.session.endsWith(`:${project}`) && !p.session.toLowerCase().startsWith("macbook")),
    [peers, project],
  );
  useEffect(() => {
    let alive = true;
    const pull = () => {
      for (const s of seats) {
        const name = seatName(s.session);
        seatDiff(project, name)
          .then(d => { if (alive) setSeatCounts(prev => ({ ...prev, [name]: d.files.length })); })
          .catch(() => {});
      }
    };
    pull();
    const iv = setInterval(pull, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, [seats, project]);

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

  // CHANGED rows: every changed path, counts where git measured them, "new" where it could not.
  const changedRows = useMemo(() => {
    if (!changed) return [];
    const { staged, unstaged, untracked } = {
      staged: changed.status.filter(e => e.x !== " " && e.x !== "?"),
      unstaged: changed.status.filter(e => e.y !== " " && e.y !== "?" && e.x !== "?"),
      untracked: changed.status.filter(e => e.x === "?").map(e => e.path),
    };
    const seen = new Set<string>();
    const rows: { path: string; fresh: boolean }[] = [];
    for (const e of [...staged, ...unstaged]) {
      if (!seen.has(e.path)) { seen.add(e.path); rows.push({ path: e.path, fresh: false }); }
    }
    for (const p of untracked) {
      if (!seen.has(p)) { seen.add(p); rows.push({ path: p, fresh: true }); }
    }
    const f = filter.toLowerCase();
    return f ? rows.filter(r => r.path.toLowerCase().includes(f)) : rows;
  }, [changed, filter]);

  const modeBtn = (m: Mode, label: string, dot?: boolean) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      data-on={mode === m}
      className={`flex items-center gap-1.5 rounded-[7px] px-2.5 py-[5px] text-[12px] font-medium text-tr-muted data-[on=true]:bg-white/[0.07] data-[on=true]:text-tr-text`}
    >
      {dot && <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-tr-doing" />}
      {label}
    </button>
  );

  return (
    <div
      className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-[12px] border border-tr-edge bg-tr-main"
      style={{ width: mode === "chat" ? 440 : 300, margin: 12 }}
    >
      {/* mode rail */}
      <div className="flex shrink-0 items-center gap-1 border-b border-tr-edge px-3 py-2.5">
        {modeBtn("files", "Files")}
        {modeBtn("git", "Git")}
        {modeBtn("sessions", "Sessions")}
        <div className="flex-1" />
        {modeBtn("chat", "Chat", true)}
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
            CHANGED · {seat ? `seat/${seat}` : "project"}
          </div>
          <div className="max-h-[190px] shrink-0 overflow-y-auto px-1.5">
            {!seat && (
              <div className="px-2 py-1 text-[11.5px] text-tr-muted/70">Pick a seat below — the project checkout has no per-seat change list.</div>
            )}
            {seat && changedRows.length === 0 && (
              <div className="px-2 py-1 text-[11.5px] text-tr-muted/70">{changed ? "Clean — no changes." : "reading…"}</div>
            )}
            {seat && changedRows.map(r => (
              <button
                key={r.path}
                type="button"
                onClick={() => onOpenFile(r.path)}
                title={`${r.path} — open the editable diff`}
                className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1 text-left hover:bg-white/[0.05]"
              >
                <span className="tr-mono min-w-0 flex-1 truncate text-[11.5px] text-tr-muted">{tailPath(r.path)}</span>
                {r.fresh ? (
                  <span className="tr-mono shrink-0 text-[10px] text-tr-warn">new</span>
                ) : (
                  (() => {
                    const n = lineCountFor(changed?.counts ?? [], r.path);
                    return n ? (
                      <span className="tr-mono shrink-0 text-[10px] tabular-nums">
                        <span style={{ color: "var(--git-decoration-added)" }}>+{n.plus}</span>
                        <span style={{ color: "var(--git-decoration-deleted)" }}>−{n.minus}</span>
                      </span>
                    ) : null;
                  })()
                )}
              </button>
            ))}
          </div>
          <div className="px-3 pb-0.5 pt-3 text-[9px] font-semibold tracking-[0.13em] text-tr-muted/60">ALL FILES</div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-1">
            <FileTree
              project={project}
              seat={seat}
              openPath={null}
              onOpen={p => onOpenFile(p)}
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

      {/* SESSIONS — an honest ghost: the per-seat live terminal pane is the next wave, and
          nothing here pretends otherwise. */}
      {mode === "sessions" && (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <div className="tr-card-ghost max-w-[240px] px-4 py-5 text-center text-[12px] leading-relaxed">
            Sessions — each seat's live terminal, in this pane — is the next wave. Nothing is
            faked here yet.
          </div>
        </div>
      )}

      {/* CHAT — the orchestrator conversation, moved whole from the old dock. The editor
          narrows, never disappears (ChatFocused.dc.html). */}
      {mode === "chat" && (
        <Chat project={project} dock="right" onDock={() => {}} onClose={() => setMode("files")} />
      )}

      {/* seat scope selector — the bottom of the pane, one picker for tree, editor, and git */}
      <div className="flex shrink-0 flex-wrap gap-1 border-t border-tr-edge px-3 py-2.5">
        <button
          type="button"
          onClick={() => onSeat(null)}
          data-on={seat === null}
          className="rounded-[7px] px-2.5 py-[3px] text-[11px] text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
        >
          project
        </button>
        {seats.map(s => {
          const name = seatName(s.session);
          return (
            <button
              key={s.session}
              type="button"
              onClick={() => onSeat(name)}
              data-on={seat === name}
              className="rounded-[7px] px-2.5 py-[3px] text-[11px] text-tr-muted data-[on=true]:bg-tr-panel data-[on=true]:text-tr-text data-[on=true]:shadow-sm"
            >
              {name}
              {(seatCounts[name] ?? 0) > 0 && <span className="ml-1 text-tr-doing">{seatCounts[name]}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
