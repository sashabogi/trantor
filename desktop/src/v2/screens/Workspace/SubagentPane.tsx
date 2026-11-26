// A sub-agent's conversation, read-only and live: the chat's own 2.0 transcript over its transcript tail (#14265, #14327).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPinned } from "../../../features/chat/scrollPin";
import { applyBackfill, emptyChat, type Backfill, type ChatState, type Turn } from "../../../features/chat/streaming";
import { Transcript } from "../../chat/Transcript";
import type { SeatView } from "./seatModel";

export const RUNNING_POLL_MS = 2_000;
export const IDLE_POLL_MS = 15_000;

/** Tails the agent's transcript from the last line seen; the poll slows once the agent is done. */
function useAgentChat(project: string, id: string, running: boolean): ChatState {
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const seen = useRef(0);
  const live = useRef(running);
  live.current = running;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    seen.current = 0;
    setChat(emptyChat);
    const tick = async () => {
      const after = seen.current;
      try {
        // SAFETY: subagent_tail answers the same JSON tuple orchestrator_chat does, which is Backfill.
        const b = JSON.parse(await invoke<string>("subagent_tail", { project, id, after })) as Backfill;
        if (alive) { setChat(s => applyBackfill(s, b, after)); seen.current = Math.max(b[2], after); }
      } catch { /* the file may not exist yet; the next tick tries again */ }
      if (alive) timer = setTimeout(tick, live.current ? RUNNING_POLL_MS : IDLE_POLL_MS);
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [project, id]);
  return chat;
}

/** The first line of the agent's last spoken message: what it reported when it finished. */
export function finalLine(turns: Turn[]): string {
  for (const t of [...turns].reverse()) {
    if (t.role !== "assistant") continue;
    const text = [...t.blocks].reverse().find(b => b.kind === "text" && b.text.trim())?.text.trim();
    if (text) return text.split("\n")[0].slice(0, 200);
  }
  return "";
}

export function SubagentPane({ project, seat }: { project: string; seat: SeatView }) {
  const info = seat.agentInfo;
  const id = info?.id ?? "";
  const running = info?.state === "running";
  const chat = useAgentChat(project, id, running);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [chat.turns]);
  if (!info) return null;
  const summary = running ? "" : finalLine(chat.turns);
  return (
    <div data-testid="subagent-pane" data-agent-id={id} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!running && (
        <div role="status" data-testid="agent-summary" className="shrink-0 truncate border-b border-[var(--v2-edge)] bg-[var(--v2-sunken)] px-4 py-2 text-v2-body text-[var(--v2-text-2)]" title={summary}>
          <span className="font-semibold text-[var(--v2-text)]">Finished</span>{summary ? `: ${summary}` : ""}
        </div>
      )}
      <div ref={scroller} role="log" aria-label={`${seat.label} conversation`} className="min-h-0 flex-1 overflow-y-auto"
        onScroll={e => { pinned.current = isPinned(e.currentTarget); }}>
        {!chat.turns.length && <div className="px-4 py-3 text-v2-base text-[var(--v2-muted)]">Reading the agent&apos;s conversation</div>}
        <Transcript turns={chat.turns} results={chat.results} working={running} />
      </div>
    </div>
  );
}
