// Talking to the orchestrator, as a conversation.
//
// The session runs in a terminal — that is what keeps slash commands, plan mode and everything else
// the harness does. But a terminal is a bad place to READ a conversation, so this renders the
// transcript claude writes anyway and types into the pane the way a person would. Orca calls the
// same approach "native chat"; this is the same architecture with our own decoding.
//
// The first version dropped tool calls to avoid a wall of text. That was the wrong call: what an
// agent DID is most of what you want to see. They render as collapsed cards instead, and a result
// fills its card in when it arrives, which is usually a later row than the call.
//
// Liveness is row-level (#5475): the watcher (#5474) pushes each transcript row as it lands, so a
// turn in progress renders progressively instead of appearing on the next 2s poll. The whole state
// machine lives in streaming.ts so the cursor rules are testable without a window; this file is
// only the wiring — backfill once via orchestrator_chat, then chat_watch + the two events, with
// the old poll kept as the transport when the watcher is not offered (older build, or no session
// behind the pane yet).
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronRight, Wrench } from "lucide-react";
import { orchestratorOf } from "../workspace/herdr";
import { Composer, type Provenance } from "./Composer";
import {
  applyBackfill, applyRows, applySessionChanged, emptyChat, sessionLiveness,
  type Backfill, type Block, type ChatState, type RowsPayload, type SessionPayload,
  type ToolResult, type Turn,
} from "./streaming";

export type Dock = "right" | "bottom";

/** Consecutive turns from the same speaker are ONE thing to a reader. The transcript splits them
 *  every time a tool runs, which is why the panel showed "ORCHESTRATOR" stacked above every card. */
/** Consecutive tool blocks become one array; everything else passes through. */
function batch(blocks: Block[]): Array<Block | Block[]> {
  const out: Array<Block | Block[]> = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.kind === "tool") {
      if (Array.isArray(last)) last.push(b);
      else out.push([b]);
    } else out.push(b);
  }
  return out;
}

function group(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.blocks = [...last.blocks, ...t.blocks];
    else out.push({ role: t.role, blocks: [...t.blocks] });
  }
  return out;
}

/** A run of consecutive tool calls is ONE act to a reader — "checked nine things" — not nine
 *  stacked cards around a single sentence. Failures stay visible while collapsed, because a run
 *  that went wrong is exactly the one you want to open. */
function ToolRun({ blocks, results }: { blocks: Block[]; results: Record<string, ToolResult> }) {
  const [open, setOpen] = useState(false);
  const failed = blocks.filter(b => b.tool_id && results[b.tool_id] && !results[b.tool_id].ok).length;
  const running = blocks.filter(b => !b.tool_id || !results[b.tool_id]).length;
  if (blocks.length === 1) return <ToolCard block={blocks[0]} result={blocks[0].tool_id ? results[blocks[0].tool_id] : undefined} />;
  return (
    <div className="mt-1.5">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-1.5 rounded-lg border border-tr-edge bg-black/20 px-2.5 py-1.5 text-left">
        <ChevronRight size={11} strokeWidth={2.5} className="shrink-0" style={{ transform: open ? "rotate(90deg)" : undefined }} />
        <Wrench size={11} strokeWidth={1.75} className="shrink-0 opacity-60" />
        <span className="text-[11.5px] font-medium">{blocks.length} tools</span>
        <span className="tr-mono min-w-0 flex-1 truncate text-[11px] text-tr-muted">
          {[...new Set(blocks.map(b => b.tool))].join(", ")}
        </span>
        {failed > 0 && <span className="shrink-0 text-[10.5px] text-tr-danger">{failed} failed</span>}
        {failed === 0 && running > 0 && <span className="shrink-0 text-[10.5px] text-tr-doing">running</span>}
      </button>
      {open && blocks.map((b, i) => <ToolCard key={i} block={b} result={b.tool_id ? results[b.tool_id] : undefined} />)}
    </div>
  );
}

function ToolCard({ block, result }: { block: Block; result?: ToolResult }) {
  const [open, setOpen] = useState(false);
  // Running until its answer arrives. Saying so beats an empty card that looks finished.
  const state = result ? (result.ok ? "ok" : "failed") : "running";
  const colour = state === "failed" ? "var(--color-tr-danger)" : state === "ok" ? "var(--color-tr-muted)" : "var(--color-tr-doing)";
  return (
    <div className="mt-1.5 overflow-hidden rounded-lg border border-tr-edge bg-black/20">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left">
        <ChevronRight size={11} strokeWidth={2.5} className="shrink-0 transition-transform" style={{ transform: open ? "rotate(90deg)" : undefined, color: colour }} />
        <Wrench size={11} strokeWidth={1.75} className="shrink-0 opacity-60" />
        <span className="shrink-0 text-[11.5px] font-medium">{block.tool}</span>
        <span className="tr-mono min-w-0 flex-1 truncate text-[11px] text-tr-muted">{block.text}</span>
        {state !== "ok" && <span className="shrink-0 text-[10.5px]" style={{ color: colour }}>{state}</span>}
      </button>
      {open && (
        <div className="border-t border-tr-edge px-2.5 py-2">
          {block.text && <pre className="tr-mono mb-2 whitespace-pre-wrap break-words text-[11px] text-tr-muted">{block.text}</pre>}
          {result ? (
            <pre className="tr-mono max-h-[280px] overflow-auto whitespace-pre-wrap break-words text-[11px]">{result.preview || "(no output)"}</pre>
          ) : (
            <div className="text-[11px] text-tr-muted">still running…</div>
          )}
        </div>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-[11px] text-tr-muted hover:text-tr-text">
        <ChevronRight size={11} strokeWidth={2.5} style={{ transform: open ? "rotate(90deg)" : undefined }} />
        thinking
      </button>
      {open && <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-black/20 px-2.5 py-2 text-[11.5px] leading-relaxed text-tr-muted">{text}</pre>}
    </div>
  );
}

export function Chat({ project, dock, onDock, onClose }: {
  project: string; dock: Dock; onDock: (d: Dock) => void; onClose: () => void;
}) {
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mid-turn or not. Asked of the pane (herdr's agent list) rather than guessed from the
  // transcript, because a turn in progress has written nothing yet. The full status string also
  // decides whether the composer is worth typing into (#5477) — a registered pane whose agent
  // exited must not look like a conversation.
  const [status, setStatus] = useState("unknown");
  // True once the watcher is feeding us events; false means the 2s poll IS the transport.
  const [streamed, setStreamed] = useState(false);
  // What the session REPORTED, versus what we sent and have not seen confirmed.
  const [modelSource, setModelSource] = useState<Provenance>("unknown");
  const [pending, setPending] = useState<string>("");
  const foot = useRef<HTMLDivElement | null>(null);
  // The decision cursor: updated synchronously where the state is updated asynchronously, so two
  // arrivals in one tick still see the cursor the first one left.
  const seenRef = useRef(0);
  const syncRef = useRef<() => void>(() => {});

  useEffect(() => {
    setChat(emptyChat); seenRef.current = 0; setError(null); setStatus("unknown");
    orchestratorOf(project).then(o => setTarget(o?.surface ?? null)).catch(() => setTarget(null));
  }, [project]);

  /** Fetch everything past the cursor and fold it in. This is the backfill, the mismatch repair
   *  and the post-send refresh — one path, so they cannot disagree. */
  const sync = useCallback(() => {
    const after = seenRef.current;
    invoke<string>("orchestrator_chat", { project, after })
      .then(raw => {
        // JSON.parse's `any` flows into the tuple without a cast — Rust owns validation, the
        // same boundary herdr.ts documents for herdr_seats().
        const b: Backfill = JSON.parse(raw);
        const m = b[3];
        if (m.model) {
          // A reported model outranks a dispatch: the session has spoken, so the guess retires.
          setModelSource("reported");
          setPending(p => (p === m.model ? "" : p));
        }
        if (b[2] < after) {
          // The transcript went BACKWARD — shorter than where we are. That is a handoff having
          // swapped in a new file; rows 0..b[2] are the conversation now, so restart from the
          // top as a continuation rather than skipping the new session entirely.
          seenRef.current = 0;
          setChat(s => applySessionChanged(s));
          syncRef.current();
          return;
        }
        seenRef.current = b[2];
        setChat(s => applyBackfill(s, b, after));
        setError(null);
      })
      .catch(e => setError(String(e)));
  }, [project]);
  syncRef.current = sync;

  useEffect(() => {
    let alive = true;
    const offs: Array<() => void> = [];
    let badFrames = 0;
    setStreamed(false);
    // The contract keeps the initial whole-file read on orchestrator_chat; the watcher takes over
    // from there. Until it can (its command missing on an older build, or no session yet), the
    // poll below is the transport this view has always had.
    sync();
    void (async () => {
      try {
        const count = await invoke<number>("chat_watch", { project });
        if (!alive) return;
        // Rows that landed while the watcher was spinning up would otherwise sit between our
        // cursor and the first event's after — close the gap now.
        if (count > seenRef.current) sync();
        offs.push(await listen<string>("chat-rows", ev => {
          if (!alive) return;
          try {
            const p: RowsPayload = JSON.parse(ev.payload);
            if (p.project !== project) return;
            badFrames = 0;
            if (p.after !== seenRef.current) { syncRef.current(); return; }
            seenRef.current = p.total ?? p.after + p.turns.length;
            setChat(s => applyRows(s, p).state);
          } catch {
            // Three bad frames in a row means the payload is not the shape we decode — say so by
            // falling back to polling rather than dying silently.
            if (++badFrames >= 3) setStreamed(false);
          }
        }));
        offs.push(await listen<string>("chat-session-changed", ev => {
          if (!alive) return;
          try {
            const p: SessionPayload = JSON.parse(ev.payload);
            if (p.project !== project) return;
            seenRef.current = 0;
            setChat(s => applySessionChanged(s));
            syncRef.current();
          } catch { if (++badFrames >= 3) setStreamed(false); }
        }));
        if (alive) setStreamed(true);
      } catch {
        // No watcher to be had — the poll fallback carries the view.
      }
    })();
    return () => {
      alive = false;
      for (const off of offs) off();
      invoke("chat_unwatch", { project }).catch(() => {});
    };
  }, [project, target !== null, sync]);

  // The poll transport: runs until the watcher takes over, and again if it ever gives up.
  useEffect(() => {
    if (streamed) return;
    const iv = setInterval(sync, 2_000);
    return () => clearInterval(iv);
  }, [streamed, sync]);

  useEffect(() => {
    let alive = true;
    const look = () => { invoke<string>("orchestrator_status", { project }).then(st => { if (alive) setStatus(st); }).catch(() => {}); };
    look();
    const iv = setInterval(look, 3_000);
    return () => { alive = false; clearInterval(iv); };
  }, [project]);
  useEffect(() => { foot.current?.scrollIntoView({ behavior: "smooth" }); }, [chat.turns.length]);

  const working = status === "working";
  const liveness = sessionLiveness(status, target);
  const side = dock === "right";
  return (
    <div className={`flex min-h-0 flex-col border-tr-edge bg-tr-bg ${side ? "h-full w-[420px] shrink-0 border-l" : "h-[340px] shrink-0 border-t"}`}>
      {/* One row that cannot wrap. Every part is shrink-0 except the project name, which truncates,
          because a header that reflows into three lines is what "mangled" looked like. */}
      <div className="flex shrink-0 items-center gap-2 overflow-hidden px-3 py-2">
        <span className="shrink-0 text-[12.5px] font-semibold">Orchestrator</span>
        <span className="tr-mono min-w-0 flex-1 truncate text-[11px] text-tr-muted">{project}</span>
        {/* Reported by the session, never asserted. */}
        {chat.meta.model && <span className="tr-chip shrink-0 text-[10.5px]">{chat.meta.model}</span>}
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => onDock(side ? "bottom" : "right")} title={side ? "move to the bottom" : "move to the right"} className="rounded-[7px] px-2 py-1 text-[11px] text-tr-muted hover:text-tr-text">
            {side ? "▤" : "▥"}
          </button>
          <button type="button" onClick={onClose} title="hide" className="rounded-[7px] px-2 py-1 text-[11px] text-tr-muted hover:text-tr-text">✕</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {!target && (
          <div className="tr-card-ghost px-4 py-3 text-[12px] leading-relaxed">
            No orchestrator session is hosted for this project yet. Open one from the Workspace lens
            and this becomes the conversation with it.
          </div>
        )}
        {target && chat.continued && (
          /* A handoff was adopted mid-view: what is above this line is the SAME project's next
             session, not more of the one you were reading. */
          <div className="my-2 flex items-center gap-2">
            <span className="h-px flex-1 bg-tr-edge" />
            <span className="text-[10.5px] text-tr-muted">session continued</span>
            <span className="h-px flex-1 bg-tr-edge" />
          </div>
        )}
        {target && !chat.turns.length && !chat.continued && !error && (
          <div className="px-1 py-2 text-[12px] leading-relaxed text-tr-muted">
            Nothing said yet. Type below and it reaches the session exactly as if you had typed it in
            the terminal.
          </div>
        )}
        {group(chat.turns).map((t, i) => (
          <div key={i} className="mb-3">
            <div className="mb-1 text-[10.5px] uppercase tracking-wider text-tr-muted">
              {t.role === "user" ? "you" : "orchestrator"}
            </div>
            {batch(t.blocks).map((b, j) =>
              Array.isArray(b) ? (
                <ToolRun key={j} blocks={b} results={chat.results} />
              ) : b.kind === "thinking" ? (
                <Thinking key={j} text={b.text} />
              ) : b.kind === "image" ? (
                <div key={j} className="mt-1.5 text-[11.5px] text-tr-muted">[image]</div>
              ) : (
                <div
                  key={j}
                  className={`whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[12.5px] leading-relaxed ${
                    t.role === "user" ? "bg-tr-panel" : "bg-black/25"
                  }`}
                >
                  {b.text}
                </div>
              ),
            )}
          </div>
        ))}
        <div ref={foot} />
      </div>

      {error && <div className="tr-mono px-3 pb-1 text-[11px] text-tr-danger">{error}</div>}

      <Composer
        project={project}
        target={target}
        live={liveness.live}
        liveWhy={liveness.why}
        model={pending || chat.meta.model}
        modelSource={pending ? "dispatched" : modelSource}
        working={working}
        onSent={sync}
        onDispatch={(dial, value) => { if (dial === "model") { setPending(value); setModelSource("dispatched"); } }}
      />
    </div>
  );
}
