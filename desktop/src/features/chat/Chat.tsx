// Talking to the orchestrator, as a conversation.
//
// The session runs in a terminal — that is what keeps slash commands, plan mode and everything else
// the harness does. But a terminal is a bad place to READ a conversation, so this renders the
// transcript claude writes anyway and types into the pane the way a person would. Orca calls the
// same approach "native chat"; this is the same architecture with our own decoding.
//
// The first version dropped tool calls to avoid a wall of text. That was the wrong call: what an
// agent DID is most of what you want to see. They render as collapsed cards instead, and a result
// fills its card in when it arrives, which is usually a later poll than the call.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, Wrench } from "lucide-react";
import { orchestratorOf } from "../workspace/herdr";
import { Composer, type Provenance } from "./Composer";

export type Dock = "right" | "bottom";

type Block = { kind: "text" | "thinking" | "tool" | "image"; text: string; tool?: string; tool_id?: string };
type Turn = { role: "user" | "assistant"; blocks: Block[] };
type ToolResult = { tool_id: string; ok: boolean; preview: string };
/** What the agent IS, reported by the session itself. Empty means unknown, and unknown renders as
 *  absent rather than as a default that would look like knowledge. */
type Meta = { model: string; version: string; branch: string };

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
  const [turns, setTurns] = useState<Turn[]>([]);
  const [results, setResults] = useState<Record<string, ToolResult>>({});
  const [seen, setSeen] = useState(0);
  const [meta, setMeta] = useState<Meta>({ model: "", version: "", branch: "" });
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // What the session REPORTED, versus what we sent and have not seen confirmed.
  const [modelSource, setModelSource] = useState<Provenance>("unknown");
  const [pending, setPending] = useState<string>("");
  const foot = useRef<HTMLDivElement | null>(null);
  const seenRef = useRef(0);
  seenRef.current = seen;

  useEffect(() => {
    setTurns([]); setResults({}); setSeen(0); seenRef.current = 0; setError(null);
    setMeta({ model: "", version: "", branch: "" });
    orchestratorOf(project).then(o => setTarget(o?.surface ?? null)).catch(() => setTarget(null));
  }, [project]);

  const poll = useCallback(() => {
    invoke<string>("orchestrator_chat", { project, after: seenRef.current })
      .then(raw => {
        const [fresh, rs, total, m]: [Turn[], ToolResult[], number, Meta] = JSON.parse(raw);
        if (m.model || m.version || m.branch) {
          setMeta(cur => ({ ...cur, ...m }));
          // A reported model outranks a dispatch: the session has spoken, so the guess retires.
          if (m.model) { setModelSource("reported"); setPending(p => (p === m.model ? "" : p)); }
        }
        if (fresh.length) setTurns(t => [...t, ...fresh]);
        // Results arrive after the calls they answer, so they are merged by id rather than
        // rendered in place — the card that has been on screen for a second fills itself in.
        if (rs.length) setResults(m => { const n = { ...m }; for (const r of rs) n[r.tool_id] = r; return n; });
        setSeen(total);
        setError(null);
      })
      .catch(e => setError(String(e)));
  }, [project]);

  useEffect(() => { poll(); const iv = setInterval(poll, 2_000); return () => clearInterval(iv); }, [poll]);

  // Mid-turn or not. Drives the stop button, and is asked of herdr rather than guessed from the
  // transcript, because a turn in progress has written nothing yet.
  useEffect(() => {
    let alive = true;
    const look = () => { invoke<string>("orchestrator_status", { project }).then(st => { if (alive) setWorking(st === "working"); }).catch(() => {}); };
    look();
    const iv = setInterval(look, 3_000);
    return () => { alive = false; clearInterval(iv); };
  }, [project]);
  useEffect(() => { foot.current?.scrollIntoView({ behavior: "smooth" }); }, [turns.length]);

  const side = dock === "right";
  return (
    <div className={`flex min-h-0 flex-col border-tr-edge bg-tr-bg ${side ? "h-full w-[420px] shrink-0 border-l" : "h-[340px] shrink-0 border-t"}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[12.5px] font-semibold">Orchestrator</span>
        <span className="tr-mono text-[11px] text-tr-muted">{project}</span>
        {/* Reported by the session, never asserted. "You would not know what kind of agent it is"
            was fair: nothing on screen said. */}
        {meta.model && <span className="tr-chip text-[10.5px]">{meta.model}</span>}
        {meta.branch && <span className="tr-mono text-[10.5px] text-tr-muted">{meta.branch}</span>}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => onDock(side ? "bottom" : "right")} className="rounded-[7px] px-2 py-1 text-[11px] text-tr-muted hover:text-tr-text">
            {side ? "dock bottom" : "dock right"}
          </button>
          <button type="button" onClick={onClose} className="rounded-[7px] px-2 py-1 text-[11px] text-tr-muted hover:text-tr-text">hide</button>
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
            Nothing said yet. Type below and it reaches the session exactly as if you had typed it in
            the terminal.
          </div>
        )}
        {group(turns).map((t, i) => (
          <div key={i} className="mb-3">
            <div className="mb-1 text-[10.5px] uppercase tracking-wider text-tr-muted">
              {t.role === "user" ? "you" : "orchestrator"}
            </div>
            {batch(t.blocks).map((b, j) =>
              Array.isArray(b) ? (
                <ToolRun key={j} blocks={b} results={results} />
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
        model={pending || meta.model}
        modelSource={pending ? "dispatched" : modelSource}
        working={working}
        onSent={poll}
        onDispatch={(dial, value) => { if (dial === "model") { setPending(value); setModelSource("dispatched"); } }}
      />
    </div>
  );
}
