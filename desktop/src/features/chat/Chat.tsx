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
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronRight, PanelBottom, PanelBottomClose, PanelRight, PanelRightClose, Wrench } from "lucide-react";
import { orchestratorOf } from "../workspace/herdr";
import { DEFAULT_TERMINAL_DEPS, TerminalPane, type TerminalDeps } from "../workspace/TerminalPane";
import { Composer, type Provenance } from "./Composer";
import {
  clampPanel, fontScale, loadFontStep, loadPanelSize, loadTrayOpen,
  saveFontStep, savePanelSize, saveTrayOpen, type FontStep,
} from "./prefs";
import {
  applyBackfill, applyRows, applySessionChanged, emptyChat, isDividerTurn, sessionLiveness,
  type Backfill, type Block, type ChatState, type RowsPayload,
  type SessionPayload, type ToolResult, type Turn,
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
    // A queued turn never merges into a seen one (or vice versa) — merging would erase the one
    // flag that tells the operator "the session has not read this yet".
    if (last && last.role === t.role && !!last.queued === !!t.queued) last.blocks = [...last.blocks, ...t.blocks];
    else out.push({ role: t.role, blocks: [...t.blocks], queued: t.queued });
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
        <span className="text-[length:calc(11.5px*var(--chat-scale,1))] font-medium">{blocks.length} tools</span>
        <span className="tr-mono min-w-0 flex-1 truncate text-[length:calc(11px*var(--chat-scale,1))] text-tr-muted">
          {[...new Set(blocks.map(b => b.tool))].join(", ")}
        </span>
        {failed > 0 && <span className="shrink-0 text-[length:calc(10.5px*var(--chat-scale,1))] text-tr-danger">{failed} failed</span>}
        {failed === 0 && running > 0 && <span className="shrink-0 text-[length:calc(10.5px*var(--chat-scale,1))] text-tr-doing">running</span>}
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
        <span className="shrink-0 text-[length:calc(11.5px*var(--chat-scale,1))] font-medium">{block.tool}</span>
        <span className="tr-mono min-w-0 flex-1 truncate text-[length:calc(11px*var(--chat-scale,1))] text-tr-muted">{block.text}</span>
        {state !== "ok" && <span className="shrink-0 text-[length:calc(10.5px*var(--chat-scale,1))]" style={{ color: colour }}>{state}</span>}
      </button>
      {open && (
        <div className="border-t border-tr-edge px-2.5 py-2">
          {block.text && <pre className="tr-mono mb-2 whitespace-pre-wrap break-words text-[length:calc(11px*var(--chat-scale,1))] text-tr-muted">{block.text}</pre>}
          {result ? (
            <pre className="tr-mono max-h-[280px] overflow-auto whitespace-pre-wrap break-words text-[length:calc(11px*var(--chat-scale,1))]">{result.preview || "(no output)"}</pre>
          ) : (
            <div className="text-[length:calc(11px*var(--chat-scale,1))] text-tr-muted">still running…</div>
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
      <button type="button" onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-[length:calc(11px*var(--chat-scale,1))] text-tr-muted hover:text-tr-text">
        <ChevronRight size={11} strokeWidth={2.5} style={{ transform: open ? "rotate(90deg)" : undefined }} />
        thinking
      </button>
      {open && <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-black/20 px-2.5 py-2 text-[length:calc(11.5px*var(--chat-scale,1))] leading-relaxed text-tr-muted">{text}</pre>}
    </div>
  );
}

// The window filling up (#5508) moved to the composer (#5521) — the gauge lives beside the
// model/effort dials that spend the window it measures. Its implementation moved with it.

// The reading size's units (#5522): the chat root carries the step as a `--chat-scale` custom
// property, and the TRANSCRIPT's text sizes below are literal `calc()` Tailwind classes over
// it — literal, NOT helper-built, because Tailwind only emits classes its scanner can read.
// The header, composer and tray chrome keep their designed sizes, so comfort tuning never
// reflows the controls. Scales stay on text: spacing and bubbles' padding are layout, not
// reading size.

// The tray mounts the Workspace lens's live pane WATCHING ONLY (#5523). TerminalPane is not
// this tree's to edit, so the keyboard is severed at the deps seam it already exposes:
// termWrite goes nowhere while bytes keep streaming in — the same live view, read-only by
// construction rather than by a prop this file cannot add.
const TRAY_DEPS: TerminalDeps = { ...DEFAULT_TERMINAL_DEPS, termWrite: () => Promise.resolve() };

export function Chat({ project, dock, onDock, onClose }: {
  project: string; dock: Dock; onDock: (d: Dock) => void; onClose: () => void;
}) {
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reading comfort (#5522): the size the last drag left the panel at (null = the designed
  // default), the transcript's S/M/L step, and the terminal tray's fold (#5523) — all persisted
  // per the prefs module's contract, loaded once here and saved at the moment they change.
  const [panel, setPanel] = useState<{ width: number | null; height: number | null }>(
    () => ({ width: loadPanelSize("width"), height: loadPanelSize("height") }),
  );
  const [fontStep, setFontStep] = useState<FontStep>(() => loadFontStep());
  const [trayOpen, setTrayOpen] = useState<boolean>(() => loadTrayOpen());
  const root = useRef<HTMLDivElement | null>(null);
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

  /** Resize by dragging the panel's inner edge (#5522). The panel is anchored to the window's
   *  far side (right of the content, or its bottom), so the dragged edge is the NEAR one and
   *  the size is the anchored edge minus the pointer: pulling away from the content grows the
   *  panel. Clamped on every move so the pointer can never stretch the panel past its sane
   *  range; persisted once, on release. */
  const startDrag = (e: RPointerEvent<HTMLDivElement>) => {
    const anchored = root.current?.getBoundingClientRect();
    if (!anchored) return;
    e.preventDefault();
    const axis: "width" | "height" = side ? "width" : "height";
    const sizeAt = (ev: PointerEvent) =>
      clampPanel(axis === "width" ? anchored.right - ev.clientX : anchored.bottom - ev.clientY, axis);
    const move = (ev: PointerEvent) => setPanel(p => ({ ...p, [axis]: sizeAt(ev) }));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      const px = sizeAt(ev);
      setPanel(p => ({ ...p, [axis]: px }));
      savePanelSize(axis, px);
    };
    document.body.style.cursor = side ? "col-resize" : "row-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pickFont = (s: FontStep) => { setFontStep(s); saveFontStep(s); };
  const toggleTray = () => { const open = !trayOpen; setTrayOpen(open); saveTrayOpen(open); };

  // CSS custom properties have no key in React's CSSProperties, so the variable is declared as
  // part of the object's own type — an intersection, not an assertion: every key is checked.
  const rootStyle: CSSProperties & Record<"--chat-scale", string> = {
    ...(side ? { width: `${panel.width ?? 420}px` } : { height: `${panel.height ?? 340}px` }),
    "--chat-scale": String(fontScale(fontStep)),
  };

  return (
    <div
      ref={root}
      style={rootStyle}
      className={`relative flex min-h-0 flex-col border-tr-edge bg-tr-bg ${side ? "h-full shrink-0 border-l" : "shrink-0 border-t"}`}
    >
      {/* The inner edge, as a grab strip (#5522): left when the panel is docked right, top when
          it is docked bottom. touch-none so a touch drag resizes instead of scrolling. */}
      <div
        role="separator"
        aria-orientation={side ? "vertical" : "horizontal"}
        aria-label={side ? "Resize chat width" : "Resize chat height"}
        title="Drag to resize"
        onPointerDown={startDrag}
        style={{ touchAction: "none" }}
        className={side
          ? "absolute inset-y-0 left-0 z-10 w-[5px] cursor-col-resize hover:bg-white/[0.06]"
          : "absolute inset-x-0 top-0 z-10 h-[5px] cursor-row-resize hover:bg-white/[0.06]"}
      />
      {/* One row that cannot wrap. Every part is shrink-0 except the project name, which truncates,
          because a header that reflows into three lines is what "mangled" looked like. */}
      <div className="flex shrink-0 items-center gap-2 overflow-hidden px-3 py-2">
        <span className="shrink-0 text-[12.5px] font-semibold">Orchestrator</span>
        <span className="tr-mono min-w-0 flex-1 truncate text-[11px] text-tr-muted">{project}</span>
        {/* Reported by the session, never asserted. The context gauge moved out of this header
            to the composer bar (#5521), where the dials that fill the window live. */}
        {chat.meta.model && <span className="tr-chip shrink-0 text-[10.5px]">{chat.meta.model}</span>}
        <div className="flex shrink-0 items-center gap-1">
          {/* The dock toggle says what it is (#5521): an icon that reads as the target dock,
              not a mystery square. */}
          <button
            type="button"
            onClick={() => onDock(side ? "bottom" : "right")}
            title={side ? "Dock chat to bottom" : "Dock chat to right"}
            className="rounded-[7px] p-1.5 text-tr-muted hover:text-tr-text"
          >
            {side ? <PanelBottom size={13} strokeWidth={1.75} /> : <PanelRight size={13} strokeWidth={1.75} />}
          </button>
          {/* No bare ✕ (#5521): hiding is a labeled action whose undo is named right here, so
              closing the chat never becomes a dismissal you need prior knowledge to reverse. */}
          <button
            type="button"
            onClick={onClose}
            title="Hide chat — the Orchestrator button in the corner brings it back"
            className="flex items-center gap-1 rounded-[7px] px-2 py-1.5 text-[11px] text-tr-muted hover:text-tr-text"
          >
            {side ? <PanelRightClose size={13} strokeWidth={1.75} /> : <PanelBottomClose size={13} strokeWidth={1.75} />}
            hide
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {!target && (
          <div className="tr-card-ghost px-4 py-3 text-[length:calc(12px*var(--chat-scale,1))] leading-relaxed">
            No orchestrator session is hosted for this project yet. Open one from the Workspace lens
            and this becomes the conversation with it.
          </div>
        )}
        {target && chat.continued && (
          /* A handoff was adopted mid-view: what is above this line is the SAME project's next
             session, not more of the one you were reading. */
          <div className="my-2 flex items-center gap-2">
            <span className="h-px flex-1 bg-tr-edge" />
            <span className="text-[length:calc(10.5px*var(--chat-scale,1))] text-tr-muted">session continued</span>
            <span className="h-px flex-1 bg-tr-edge" />
          </div>
        )}
        {target && !chat.turns.length && !chat.continued && !error && (
          <div className="px-1 py-2 text-[length:calc(12px*var(--chat-scale,1))] leading-relaxed text-tr-muted">
            Nothing said yet. Type below and it reaches the session exactly as if you had typed it in
            the terminal.
          </div>
        )}
        {group(chat.turns).map((t, i) =>
          // Bookkeeping, not speech (#5502): a /compact record or a harness caveat renders as a
          // centered quiet mono line with no speaker label — never a bubble, never "you".
          isDividerTurn(t) ? (
            <div key={i}>
              {t.blocks.map((b, j) => (
                <div key={j} title={b.text} className="tr-mono my-2 truncate text-center text-[length:calc(10.5px*var(--chat-scale,1))] text-tr-muted">
                  {b.text}
                </div>
              ))}
            </div>
          ) : (
            <div key={i} className="mb-3">
              <div className="mb-1 flex items-center gap-1.5 text-[length:calc(10.5px*var(--chat-scale,1))] uppercase tracking-wider text-tr-muted">
                <span>{t.role === "user" ? "you" : "orchestrator"}</span>
                {t.queued && (
                  <span
                    className="rounded bg-black/30 px-1.5 py-0.5 normal-case tracking-normal text-tr-warn"
                    title="Delivered to the session's queue — it has not read this yet; it will on its next turn boundary"
                  >
                    queued
                  </span>
                )}
              </div>
              {batch(t.blocks).map((b, j) =>
                Array.isArray(b) ? (
                  <ToolRun key={j} blocks={b} results={chat.results} />
                ) : b.kind === "thinking" ? (
                  <Thinking key={j} text={b.text} />
                ) : b.kind === "image" ? (
                  <div key={j} className="mt-1.5 text-[length:calc(11.5px*var(--chat-scale,1))] text-tr-muted">[image]</div>
                ) : (
                  <div
                    key={j}
                    className={`whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[length:calc(12.5px*var(--chat-scale,1))] leading-relaxed ${
                      t.role === "user" ? "bg-tr-panel" : "bg-black/25"
                    }`}
                  >
                    {b.text}
                  </div>
                ),
              )}
            </div>
          ),
        )}
        <div ref={foot} />
      </div>

      {/* The terminal tray (#5523): the orchestrator's live pane folded under the transcript,
          watching only. Collapsed by default; opening it takes the transcript's space, not the
          composer's — reading stays possible with the terminal up. */}
      <div className="shrink-0 border-t border-tr-edge">
        <button
          type="button"
          onClick={toggleTray}
          title="The orchestrator's live terminal — watching only, typing goes nowhere"
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] text-tr-muted hover:text-tr-text"
        >
          <ChevronDown size={11} strokeWidth={2.5} className="shrink-0 transition-transform" style={{ transform: trayOpen ? undefined : "rotate(-90deg)" }} />
          <span>Terminal</span>
          <span className="text-[10.5px] opacity-70">read-only</span>
        </button>
        {trayOpen && (
          <div className="flex h-[220px] min-h-0 flex-col overflow-hidden bg-black/20">
            <TerminalPane project={project} agent="orchestrator" deps={TRAY_DEPS} />
          </div>
        )}
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
        userTexts={chat.turns.filter(t => t.role === "user").map(t => t.blocks.filter(b => b.kind === "text").map(b => b.text).join("\n"))}
        context={chat.meta.context}
        fontStep={fontStep}
        onFontStep={pickFont}
        onSent={sync}
        onDispatch={(dial, value) => { if (dial === "model") { setPending(value); setModelSource("dispatched"); } }}
      />
    </div>
  );
}
