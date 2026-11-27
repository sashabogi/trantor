import { useActivePane } from "../../ui/useActivePane";
// The chat on the right (#13988): a folded rail by default so the diff keeps the width, a Composer2
// when open, and since #14494 the conversation itself — the same transcript source the Workspace
// chat column reads for the orchestrator. #14512: folding is the top bar's right toggle, not a
// header button; crew-seat notes stay honest about the Workspace.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MessageSquare } from "lucide-react";
import { isPinned } from "../../../features/chat/scrollPin";
import { applyBackfill, emptyChat, type Backfill, type ChatState } from "../../../features/chat/streaming";
import { hubActivity } from "../../../features/workspace/seatActivity";
import type { HubClient, Peer } from "../../../shared/api/client";
import { Transcript } from "../../chat/Transcript";
import { Avatar } from "../../ui/Avatar";
import { Composer2 } from "../../ui/Composer2";
import { IconButton } from "../../ui/IconButton";
import { seatLabel, isHostSession } from "../../ui/identity";
import { useOwnMachineId } from "../../ui/useMachineId";

/** The rail talks to the orchestrator by default: the one seat whose conversation we can read here. */
export function isOrchestrator(p: Peer, machineId?: string): boolean {
  return isHostSession(p.session, machineId) || /orchestrator/i.test(p.session);
}

export function pickTarget(peers: Peer[] | null, project: string, want: string | null, machineId?: string): Peer | null {
  const mine = (peers ?? []).filter(p => p.project === project || p.session.endsWith(`:${project}`));
  if (want) return mine.find(p => p.session === want || p.session.startsWith(`${want}:`)) ?? null;
  return mine.find(p => isOrchestrator(p, machineId)) ?? null;
}

export const RUNNING_POLL_MS = 2_000;
export const IDLE_POLL_MS = 15_000;
/** The rail is narrow: it carries the conversation's tail, not its whole history. */
const LAST_TURNS = 40;

/** True when the payload is the tuple orchestrator_chat promises, so it folds into state safely. */
function isBackfill(b: Backfill): boolean {
  return Array.isArray(b) && Array.isArray(b[0]) && Array.isArray(b[1]) && Number.isFinite(b[2]) &&
    b[3] instanceof Object && !Array.isArray(b[3]);
}

/** Tails the orchestrator's transcript the way the chat's own poll path does; one loop, nudgeable. */
function useOrchChat(project: string, running: boolean, nudge: number): ChatState {
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const seen = useRef(0);
  const live = useRef(running);
  live.current = running;
  const pullRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    seen.current = 0;
    setChat(emptyChat);
    const pull = async () => {
      if (busy) return;
      busy = true;
      const after = seen.current;
      try {
        // SAFETY: Rust owns the payload's validation at the boundary herdr.ts documents; this check
        // only keeps a malformed answer from reaching the setChat reducer, where it would crash the
        // rail instead of degrading to the empty conversation.
        const b = JSON.parse(await invoke<string>("orchestrator_chat", { project, after, sessionId: null })) as Backfill;
        if (!isBackfill(b)) throw new Error("malformed orchestrator_chat payload");
        if (alive) { setChat(s => applyBackfill(s, b, after)); seen.current = Math.max(b[2], after); }
      } catch { /* no session file (or an older build): the next tick tries again */ }
      busy = false;
      if (alive) { clearTimeout(timer); timer = setTimeout(pull, live.current ? RUNNING_POLL_MS : IDLE_POLL_MS); }
    };
    pullRef.current = pull;
    void pull();
    return () => { alive = false; clearTimeout(timer); };
  }, [project]);
  // A send just went out: look for the reply now instead of waiting out the idle cadence.
  useEffect(() => { if (nudge > 0) void pullRef.current(); }, [nudge]);
  return chat;
}

/** The conversation itself, read-only and live; it mounts only while the rail is open. */
function ChatConversation({ project, running, nudge, seat, empty }: {
  project: string; running: boolean; nudge: number; seat: string; empty: string;
}) {
  const chat = useOrchChat(project, running, nudge);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.turns]);
  const shown = chat.turns.slice(-LAST_TURNS);
  const older = chat.turns.length - shown.length;
  return (
    <div ref={scroller} role="log" aria-label={`${seat} conversation`} className="min-h-0 flex-1 overflow-y-auto"
      onScroll={e => { pinned.current = isPinned(e.currentTarget); }}>
      {!chat.turns.length && <div className="px-3 py-3 text-v2-body text-[var(--v2-muted)]">{empty}</div>}
      {older > 0 && <div className="px-3 py-1.5 text-v2-small text-[var(--v2-muted)]">{older} older turn{older === 1 ? "" : "s"} above</div>}
      <Transcript turns={shown} results={chat.results} working={running} />
    </div>
  );
}

export function ChatRail({ client, project, peers, open, onToggle, draft, onDraft, want }: {
  client: HubClient; project: string; peers: Peer[] | null; open: boolean; onToggle: () => void;
  draft: string; onDraft: (v: string) => void; want: string | null;
}) {
  const pane = useActivePane();
  const [note, setNote] = useState<string | null>(null);
  const [nudge, setNudge] = useState(0);
  const machineId = useOwnMachineId();
  const target = pickTarget(peers, project, want, machineId);
  // The label a person reads: "kimi-9" for a crew seat, "orchestrator" for the host session.
  const name = target ? seatLabel(target.session, machineId) : want ?? "orchestrator";
  const talk = !want || (!!target && isOrchestrator(target, machineId));
  const running = !!target && isOrchestrator(target, machineId) && hubActivity(target.status) === "working";
  if (!open) {
    return (
      <aside {...pane} aria-label="Chat, folded" className="flex w-[46px] shrink-0 flex-col items-center gap-3 overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-chrome)] py-2.5">
        <IconButton label="Open the chat" title="Chat (folded). Click to open it" size={32} badge={draft.trim() ? 1 : null} badgeTone="info" onClick={onToggle}><MessageSquare size={16} aria-hidden /></IconButton>
        <Avatar name={name} size={24} />
      </aside>
    );
  }
  const send = (text: string) => {
    if (!target) return;
    client.send(target.session, text, project)
      .then(() => {
        onDraft("");
        setNote(talk ? `Sent to ${name}. Its reply appears here as it works.` : `Sent to ${name}. Its replies land in the Workspace.`);
        setNudge(n => n + 1);
      })
      .catch(e => setNote(e instanceof Error ? e.message : String(e)));
  };
  const hint = draft.trim() ? "Your attachment is in the box below. Edit it, then send." : "Use Add to chat on a commit or a hunk to attach it here.";
  return (
    <aside {...pane} aria-label="Chat" className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel)]">
      <div className="flex items-center gap-2 border-b border-[var(--v2-edge)] px-3 py-2">
        <span className="flex-1 text-v2-base font-semibold">Chat</span>
        <span className="inline-flex items-center gap-1.5 text-v2-body text-[var(--v2-muted)]"><Avatar name={name} size={16} />{name}</span>
      </div>
      {talk ? (
        <ChatConversation project={project} running={running} nudge={nudge} seat={name} empty={hint} />
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-3 text-v2-body leading-relaxed text-[var(--v2-muted)]">{hint}</div>
      )}
      {note && <div role="status" className="shrink-0 border-t border-[var(--v2-edge)] px-3 py-1.5 text-v2-small text-[var(--v2-text-2)]">{note}</div>}
      <div className="border-t border-[var(--v2-edge)] p-3">
        <Composer2 value={draft} onChange={onDraft} onSend={send} label={`Message ${name}`} placeholder="Plan, ask or build. Add a commit or hunk with Add to chat"
          agent={name} model={{ id: target?.model ?? "unknown", label: target?.model ?? "model unknown" }} contextPct={null}
          disabledReason={target ? null : `No ${name} session is live in this project`} />
      </div>
    </aside>
  );
}
