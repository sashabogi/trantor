import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import {
  harnessLabel,
  sessionAge,
  sessionMatches,
  sessionsList,
  sessionTranscript,
  type SessionRow,
  type SessionScope,
  type TranscriptMessage,
} from "./sessionsApi";

const SCOPES: Array<{ value: SessionScope; label: string }> = [
  { value: "worktree", label: "Worktree" },
  { value: "project", label: "Project" },
  { value: "all", label: "All" },
];

function ReadOnlyTranscript({ project, session, onBack }: {
  project: string;
  session: SessionRow;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setMessages([]);
    setError(null);
    sessionTranscript(project, session)
      .then(rows => { if (alive) setMessages(rows); })
      .catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, [project, session.id, session.harness]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-tr-edge px-3 py-2.5">
        <button type="button" onClick={onBack} title="Back to session history"
          className="rounded-[7px] p-1 text-tr-muted hover:bg-white/[0.05] hover:text-tr-text">
          <ArrowLeft size={13} strokeWidth={1.75} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium">{session.title}</div>
          <div className="tr-mono truncate text-[10.5px] text-tr-muted">
            {harnessLabel(session.harness)} · {session.messageCount.toLocaleString()} msgs · read-only
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!messages.length && !error && <div className="py-3 text-[12px] text-tr-muted">Reading transcript…</div>}
        {error && <div className="tr-mono py-3 text-[11px] text-tr-fail">{error}</div>}
        {messages.map((message, index) => (
          <div key={`${index}:${message.role}`} className="mb-3" style={{ contentVisibility: "auto", containIntrinsicSize: "0 64px" }}>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-tr-muted">
              {message.role === "user" ? "you" : harnessLabel(session.harness)}
            </div>
            <div className={`whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[12px] leading-relaxed ${
              message.role === "user" ? "bg-tr-panel" : "bg-black/25"
            }`}>
              {message.text}
            </div>
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-tr-edge px-3 py-2 text-[10.5px] text-tr-muted">
        Historical transcript · no messages or commands are sent from this view.
      </div>
    </div>
  );
}

export function SessionsMode({ project, onOpenClaude }: {
  project: string;
  onOpenClaude: (session: SessionRow) => void;
}) {
  const [scope, setScope] = useState<SessionScope>("project");
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SessionRow | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    sessionsList(project, scope)
      .then(rows => { if (alive) setSessions(rows); })
      .catch(reason => { if (alive) setError(String(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [project, scope]);

  const visible = useMemo(
    () => sessions.filter(session => sessionMatches(session, query)),
    [sessions, query],
  );

  if (selected) {
    return <ReadOnlyTranscript project={project} session={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[12.5px] font-semibold">Session history</span>
          <span className="tr-mono min-w-0 flex-1 truncate text-[10.5px] text-tr-muted">
            {project} · {sessions.length.toLocaleString()} sessions
          </span>
        </div>
        <div className="tr-seg grid grid-cols-3 gap-px [&>button]:justify-center [&>button]:text-[10.5px]">
          {SCOPES.map(item => (
            <button key={item.value} type="button" data-on={scope === item.value}
              onClick={() => { setScope(item.value); setSelected(null); }}>
              {item.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 rounded-[8px] border border-tr-edge px-2.5 py-[6px] focus-within:border-tr-doing/50">
          <Search size={12} strokeWidth={1.75} className="shrink-0 text-tr-muted" />
          <input value={query} onChange={event => setQuery(event.target.value)}
            placeholder="Search sessions…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-tr-text outline-none placeholder:text-tr-muted/60" />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading && <div className="px-2 py-3 text-[12px] text-tr-muted">Reading harness stores…</div>}
        {error && <div className="tr-mono px-2 py-3 text-[11px] text-tr-fail">{error}</div>}
        {!loading && !error && visible.length === 0 && (
          <div className="px-2 py-3 text-[12px] text-tr-muted">No sessions match this scope and search.</div>
        )}
        <div className="flex flex-col gap-1.5">
          {visible.map(session => (
            <button key={`${session.harness}:${session.id}`} type="button"
              onClick={() => session.harness === "claude" ? onOpenClaude(session) : setSelected(session)}
              className="w-full rounded-[10px] border border-tr-edge bg-white/[0.025] px-3 py-2.5 text-left hover:bg-white/[0.05]"
              style={{ contentVisibility: "auto", containIntrinsicSize: "0 62px" }}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{session.title}</span>
                <span className="tr-mono shrink-0 text-[10px] text-tr-muted">{sessionAge(session.updatedAt)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 tr-mono text-[10px]">
                <span className="shrink-0 text-tr-text">{harnessLabel(session.harness)}</span>
                <span className="min-w-0 flex-1 truncate text-tr-muted">
                  {session.messageCount.toLocaleString()} msgs · {session.model || "model unavailable"}
                </span>
                {session.branch && (
                  <span className="shrink-0 rounded-[6px] bg-tr-doing/10 px-1.5 py-0.5 text-tr-doing">
                    {session.branch}
                  </span>
                )}
              </div>
              {session.lastMessage && session.lastMessage !== session.title && (
                <div className="mt-1 truncate text-[10.5px] text-tr-muted/75">{session.lastMessage}</div>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="shrink-0 border-t border-tr-edge px-3 py-2 text-[10.5px] leading-relaxed text-tr-muted">
        Read from every harness&apos;s own transcript store on disk. Click a session to open its conversation.
      </div>
    </div>
  );
}
