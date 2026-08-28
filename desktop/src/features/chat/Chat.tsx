// Talking to the orchestrator, as a conversation.
//
// The session still runs in a terminal — that is what keeps slash commands, plan mode and every
// other thing the harness does. But a terminal is a bad place to READ a conversation: escape codes,
// reflowed wrapping, and no structure to render against. So this reads the transcript claude
// writes anyway, and types into the pane the way a person would.
//
// Which means the transcript had to be addressable, and it is only addressable because `trantor
// open` chooses the session id rather than discovering it. The persistence work paid for this.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { orchestratorOf } from "../workspace/herdr";

export type Dock = "right" | "bottom";
type Turn = { role: "user" | "assistant"; text: string };

export function Chat({ project, dock, onDock, onClose }: {
  project: string;
  dock: Dock;
  onDock: (d: Dock) => void;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [seen, setSeen] = useState(0);
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const foot = useRef<HTMLDivElement | null>(null);
  // Held in a ref so the poll closure never captures a stale cursor and re-reads the whole file.
  const seenRef = useRef(0);
  seenRef.current = seen;

  useEffect(() => {
    setTurns([]); setSeen(0); seenRef.current = 0; setError(null);
    orchestratorOf(project).then(o => setTarget(o?.surface ?? null)).catch(() => setTarget(null));
  }, [project]);

  const poll = useCallback(() => {
    invoke<string>("orchestrator_chat", { project, after: seenRef.current })
      .then(raw => {
        const [fresh, total]: [Turn[], number] = JSON.parse(raw);
        if (fresh.length) setTurns(t => [...t, ...fresh]);
        setSeen(total);
        setError(null);
      })
      .catch(e => setError(String(e)));
  }, [project]);

  useEffect(() => {
    poll();
    const iv = setInterval(poll, 2_000);
    return () => clearInterval(iv);
  }, [poll]);

  useEffect(() => { foot.current?.scrollIntoView({ behavior: "smooth" }); }, [turns.length]);

  const send = () => {
    const text = draft.trim();
    if (!text || !target) return;
    setSending(true);
    invoke("pane_send", { target, text })
      .then(() => { setDraft(""); setError(null); })
      .catch(e => setError(String(e)))
      .finally(() => setSending(false));
  };

  const side = dock === "right";
  return (
    <div className={`flex min-h-0 flex-col border-tr-edge bg-tr-bg ${side ? "h-full w-[380px] shrink-0 border-l" : "h-[320px] shrink-0 border-t"}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[12.5px] font-semibold">Orchestrator</span>
        <span className="tr-mono text-[11px] text-tr-muted">{project}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => onDock(side ? "bottom" : "right")}
            title={side ? "move to the bottom" : "move to the right"}
            className="rounded-[7px] px-2 py-1 text-[11px] text-tr-muted hover:text-tr-text"
          >
            {side ? "dock bottom" : "dock right"}
          </button>
          <button type="button" onClick={onClose} title="hide" className="rounded-[7px] px-2 py-1 text-[11px] text-tr-muted hover:text-tr-text">
            hide
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {!target && (
          <div className="tr-card-ghost px-4 py-3 text-[12px] leading-relaxed">
            No orchestrator session is hosted for this project yet. Open one from the Workspace lens
            and this becomes the conversation with it.
          </div>
        )}
        {target && !turns.length && !error && (
          <div className="px-1 py-2 text-[12px] leading-relaxed text-tr-muted">
            Nothing said yet. Type below and it goes to the session, exactly as if you had typed it
            in the terminal.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="mb-3">
            <div className="mb-1 text-[10.5px] uppercase tracking-wider text-tr-muted">
              {t.role === "user" ? "you" : "orchestrator"}
            </div>
            <div
              className={`whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[12.5px] leading-relaxed ${
                t.role === "user" ? "bg-tr-panel" : "bg-black/25"
              }`}
            >
              {t.text}
            </div>
          </div>
        ))}
        <div ref={foot} />
      </div>

      {error && <div className="tr-mono px-3 pb-1 text-[11px] text-tr-danger">{error}</div>}

      <div className="border-t border-tr-edge p-2">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            // Enter sends, shift+Enter is a newline. The terminal underneath submits on Enter, so
            // matching it here keeps the two surfaces feeling like one session.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder={target ? "Message the orchestrator…  (⇧⏎ for a new line)" : "no session to talk to"}
          disabled={!target || sending}
          rows={dock === "right" ? 3 : 2}
          className="w-full resize-none rounded-lg bg-black/30 p-2.5 text-[12.5px] leading-relaxed outline-none placeholder:text-tr-muted disabled:opacity-50"
        />
      </div>
    </div>
  );
}
