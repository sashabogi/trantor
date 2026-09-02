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
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ChevronDown, ChevronRight, PanelBottom, PanelBottomClose, PanelRight, PanelRightClose, Wrench } from "lucide-react";
import { orchestratorOf, type HerdrSeat } from "../workspace/herdr";
import { DEFAULT_TERMINAL_DEPS, TerminalPane, type TerminalDeps } from "../workspace/TerminalPane";
import { bannerCountdown, type HandoffCountdown } from "./banner";
import { Composer, type Provenance } from "./Composer";
import { MarkdownText } from "./MarkdownText";
import { suggestionsFromTurns } from "./suggestions";
import { SuggestionChips } from "./SuggestionChips";
import {
  clampPanel, fontScale, loadDismissedAt, loadFontStep, loadPanelSize, loadTrayOpen,
  saveDismissedAt, saveFontStep, savePanelSize, saveTrayOpen, type FontStep,
} from "./prefs";
import {
  applyBackfill, applyRows, applySessionChanged, bannerVisible, emptyChat, isDividerTurn,
  lastToolLabel, sessionLiveness, tickerText,
  type Backfill, type Block, type ChatState, type RowsPayload,
  type SessionPayload, type ToolResult, type Turn,
} from "./streaming";

/** "pane" = hosted inside the ModePane (#5841): the pane owns width, height, and the mode
 *  rail, so the chat brings no column chrome of its own — no fixed width, no resize strip, no
 *  dock/hide buttons. Rendering the dock chrome inside the pane made the chat taller than its
 *  host (h-full + rail + footer) and wider than 440 (the saved dock width), so focusing the
 *  composer scrolled the rail out of the clipped container: "no way to change it back". */
export type Dock = "right" | "bottom" | "pane";

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
        {failed > 0 && <span className="shrink-0 text-[length:calc(10.5px*var(--chat-scale,1))] text-tr-fail">{failed} failed</span>}
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
  const colour = state === "failed" ? "var(--color-tr-fail)" : state === "ok" ? "var(--color-tr-muted)" : "var(--color-tr-doing)";
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

/** The window's early warning, worn as a choice (#5509 W1): at the gauge's red threshold the
 *  panel offers the handoff instead of just colouring a bar. [Hand off now] drives the same-pane
 *  replacement through the Tauri command — busy while it runs, its failure shown HERE, because a
 *  handoff that failed silently is a trap set for the next wall. Success stays quiet: the
 *  session-changed flow already draws the "session continued" divider, and the composer's
 *  liveness gate covers the gap while the pane restarts. */
function HandoffBanner({ frac, countdown, busy, error, onKeepGoing, onHandOffNow }: {
  frac: number;
  countdown: HandoffCountdown;
  busy: boolean;
  error: string | null;
  onKeepGoing: () => void;
  onHandOffNow: () => void;
}) {
  // The same rounding the gauge shows, so the banner and the bar can never name different numbers.
  const pct = Math.round(frac * 100);
  return (
    <div className="mx-2 mb-1 rounded-lg border border-tr-fail/40 bg-tr-fail/10 px-2.5 py-1.5 text-[11.5px]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          Context at <span className="tr-mono text-tr-fail">{pct}%</span> — handing off in <span className="tr-mono text-tr-fail">{countdown.remainingSec}s</span>
        </span>
        <button
          type="button"
          onClick={onHandOffNow}
          disabled={busy}
          title="Write the handoff, end this session, and open the next one in the same pane"
          className="shrink-0 rounded-[8px] bg-tr-panel px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
        >
          {busy ? "handing off…" : "Hand off now"}
        </button>
        <button
          type="button"
          onClick={onKeepGoing}
          disabled={busy}
          title="Not yet — the offer returns once context grows another 2%"
          className="shrink-0 text-tr-muted hover:underline disabled:opacity-40"
        >
          Keep going
        </button>
      </div>
      {error && <div className="tr-mono mt-1 truncate text-[10.5px] text-tr-fail" title={error}>{error}</div>}
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
const TRAY_DEPS: TerminalDeps = { ...DEFAULT_TERMINAL_DEPS, termWrite: async () => "" };

/** The seams Chat crosses, injected so a test supplies a faithful in-memory stand-in instead of
 *  mocking @tauri/herdr modules (TerminalPane's `deps` is the same idea). Production default. */
export type ChatDeps = {
  invoke: <T>(cmd: string, args?: InvokeArgs) => Promise<T>;
  listen: <T>(event: string, cb: (ev: { payload: T }) => void) => Promise<() => void>;
  orchestratorOf: (project: string) => Promise<HerdrSeat | null>;
  /** Heavy neighbours Chat mounts; the chat tests replace them with null renderers. */
  Composer: React.ComponentType<React.ComponentProps<typeof Composer>>;
  TerminalPane: React.ComponentType<React.ComponentProps<typeof TerminalPane>>;
};

export const DEFAULT_CHAT_DEPS: ChatDeps = {
  // The seam's args are the object literals Chat actually passes; tauri's InvokeArgs accepts them
  // (Record is one arm of the union), so no cast is needed to hand them to the real invoke.
  invoke: <T,>(cmd: string, args?: InvokeArgs) => invoke<T>(cmd, args),
  listen: (event, cb) => listen(event, cb),
  orchestratorOf,
  Composer,
  TerminalPane,
};

export function Chat({ project, sessionId, dock, onDock, onClose, deps = DEFAULT_CHAT_DEPS }: {
  project: string; sessionId?: string; dock: Dock; onDock: (d: Dock) => void; onClose: () => void;
  /** Test seam — production callers omit it and get the real modules. */
  deps?: ChatDeps;
}) {
  const { invoke: invokeFn, listen: listenFn, orchestratorOf: paneOf, Composer: ComposerView, TerminalPane: TermView } = deps;
  const history = Boolean(sessionId);
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [target, setTarget] = useState<string | null>(() => history ? "history" : null);
  const [error, setError] = useState<string | null>(null);
  // Reading comfort (#5522): the size the last drag left the panel at (null = the designed
  // default), the transcript's S/M/L step, and the terminal tray's fold (#5523) — all persisted
  // per the prefs module's contract, loaded once here and saved at the moment they change.
  const [panel, setPanel] = useState<{ width: number | null; height: number | null }>(
    () => ({ width: loadPanelSize("width"), height: loadPanelSize("height") }),
  );
  const [fontStep, setFontStep] = useState<FontStep>(() => loadFontStep());
  const [trayOpen, setTrayOpen] = useState<boolean>(() => loadTrayOpen());
  const [longRun, setLongRun] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [bannerArmedAt, setBannerArmedAt] = useState<number | null>(null);
  const [bannerNow, setBannerNow] = useState(() => Date.now());
  // The handoff banner's episode marker (#5509 W1): the frac "keep going" was last said at, or
  // null when the offer owes nothing. Persisted so a restart does not re-ask an answered
  // question; cleared when the episode it belonged to is over.
  const [dismissedAt, setDismissedAt] = useState<number | null>(() => loadDismissedAt());
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
  // The project this panel mounted on (#5509 W1) — lets the [project] effect tell a real switch
  // (a new episode, dismissals cleared) from the mount it must leave alone.
  const prevProject = useRef(project);
  const autoHandoffKey = useRef<string | null>(null);

  useEffect(() => {
    // A DIFFERENT project's session is a different episode (#5509 W1): a dismissal must not
    // travel across projects. Mount is not a switch — the persisted dismissal was recorded for
    // the project this panel opened on, so it survives restarts.
    const switched = prevProject.current !== project;
    prevProject.current = project;
    if (switched) { setDismissedAt(null); saveDismissedAt(null); }
    setBannerArmedAt(null); setHandoffError(null); autoHandoffKey.current = null;
    setChat(emptyChat); seenRef.current = 0; setError(null); setStatus("unknown");
    if (sessionId) setTarget("history");
    else paneOf(project).then(o => setTarget(o?.surface ?? null)).catch(() => setTarget(null));
  }, [project, sessionId]);

  // A takeover hosts the pane AFTER this panel looked for one (#5495): while none is hosted,
  // keep looking, so the conversation — and the composer's liveness — arrive on their own the
  // moment `trantor open` lands, without a project switch to notice.
  useEffect(() => {
    if (history || target !== null) return;
    let alive = true;
    const iv = setInterval(() => {
      paneOf(project).then(o => { if (alive && o) setTarget(o.surface); }).catch(() => {});
    }, 5_000);
    return () => { alive = false; clearInterval(iv); };
  }, [history, project, target]);

  /** Fetch everything past the cursor and fold it in. This is the backfill, the mismatch repair
   *  and the post-send refresh — one path, so they cannot disagree. */
  const sync = useCallback(() => {
    const after = seenRef.current;
    invokeFn<string>("orchestrator_chat", { project, after, sessionId: sessionId ?? null })
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
          // The new session's window is a new episode (#5509 W1) — a dismissal said to the OLD
          // context must not muzzle the offer when the new one fills up too.
          setDismissedAt(null); saveDismissedAt(null);
          syncRef.current();
          return;
        }
        seenRef.current = b[2];
        setChat(s => applyBackfill(s, b, after));
        setError(null);
      })
      .catch(e => setError(String(e)));
  }, [project, sessionId]);
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
        const count = await invokeFn<number>("chat_watch", { project, sessionId: sessionId ?? null });
        if (!alive) return;
        // Rows that landed while the watcher was spinning up would otherwise sit between our
        // cursor and the first event's after — close the gap now.
        if (count > seenRef.current) sync();
        offs.push(await listenFn<string>("chat-rows", ev => {
          if (!alive) return;
          try {
            const p: RowsPayload = JSON.parse(ev.payload);
            if (p.project !== project) return;
            if (sessionId && p.sessionId !== sessionId) return;
            // #5993 — the transcript says a turn ended. Re-seed the pushed status ONCE (never a
            // polling loop): the stream can freeze on `working`, and a frozen gate must not
            // outlive the batch that proves the turn is over. Fires even when the batch misses
            // the cursor — the resync heals rows, not the gate. History views keep "ended".
            if (p.turn_ended && !sessionId) {
              invokeFn<string>("orchestrator_status", { project })
                .then(st => { if (alive && st) setStatus(st); })
                .catch(() => {});
            }
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
        offs.push(await listenFn<string>("chat-session-changed", ev => {
          if (!alive) return;
          try {
            const p: SessionPayload = JSON.parse(ev.payload);
            if (p.project !== project) return;
            if (sessionId) return;
            seenRef.current = 0;
            setChat(s => applySessionChanged(s));
            setDismissedAt(null); saveDismissedAt(null);
            syncRef.current();
            // #5993 — a handoff may have restarted the pane; the pushed stream may never have
            // covered the successor. One seed here, so the gate starts honest — no loop.
            invokeFn<string>("orchestrator_status", { project })
              .then(st => { if (alive && st) setStatus(st); })
              .catch(() => {});
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
      invokeFn("chat_unwatch", { project, sessionId: sessionId ?? null }).catch(() => {});
    };
  }, [project, sessionId, target !== null, sync]);

  // The poll transport: runs until the watcher takes over, and again if it ever gives up.
  useEffect(() => {
    if (streamed) return;
    const iv = setInterval(sync, 2_000);
    return () => clearInterval(iv);
  }, [streamed, sync]);

  // Status is PUSHED (Phase 3): the backend holds a per-pane herdr subscription (spawned with
  // chat_watch) and emits "orch-status" on every lifecycle change. One seed call paints the
  // first state; after that, no polling — the 3-second `orchestrator_status` loop this
  // replaces spawned a subprocess per tick, forever.
  useEffect(() => {
    if (history) { setStatus("ended"); return; }
    let alive = true;
    invokeFn<string>("orchestrator_status", { project }).then(st => { if (alive) setStatus(st); }).catch(() => {});
    const offs: Array<() => void> = [];
    void (async () => {
      const off = await listenFn<string>("orch-status", ev => {
        if (!alive) return;
        try {
          // SAFETY: payload comes from our own Rust emitter (orch-status), and both fields are
          // re-checked before use — a malformed payload falls through the guard or the catch.
          const p = JSON.parse(ev.payload) as { project: string; status: string };
          if (p.project === project && p.status) setStatus(p.status);
        } catch {}
      });
      if (alive) offs.push(off); else off();
    })();
    return () => { alive = false; for (const off of offs) off(); };
  }, [history, project]);
  useEffect(() => { foot.current?.scrollIntoView({ behavior: "smooth" }); }, [chat.turns.length]);

  const working = status === "working";

  // Suggested-reply chips (#5929): asks collected from EVERY orchestrator turn since the
  // operator's last user turn (walk back until a user turn — the real ask is routinely one turn
  // back behind a hook-driven "Nothing to swap."), most recent ask first, capped at three.
  // Purely derived (suggestions.ts — nothing invented, no LLM call). Live only while that ask
  // turn is still the last thing said (answered → gone), composer empty (typing → gone), and
  // Esc or the × dismisses until the next orchestrator turn recomputes the row.
  const [composerDraft, setComposerDraft] = useState("");
  const [chipsDismissed, setChipsDismissed] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState<string | null>(null);
  const orchestratorTexts = useMemo(() => {
    const out: string[] = [];
    for (const t of [...chat.turns].reverse()) {
      if (t.role === "user") break;
      if (t.role === "assistant") {
        out.push(t.blocks.filter(b => b.kind === "text").map(b => b.text).join("\n"));
      }
    }
    return out;
  }, [chat.turns]);
  const suggestions = useMemo(
    () => (history || working ? [] : suggestionsFromTurns(orchestratorTexts)),
    [history, working, orchestratorTexts],
  );
  const lastSpeechTurn = [...chat.turns].reverse().find(t => t.role === "user" || t.role === "assistant");
  const chipsVisible =
    !history && !!target && !working && suggestions.length > 0 &&
    lastSpeechTurn?.role === "assistant" && !composerDraft.trim() && !chipsDismissed;
  useEffect(() => { setChipsDismissed(false); }, [orchestratorTexts]);
  useEffect(() => {
    if (!chipsVisible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setChipsDismissed(true); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chipsVisible]);
  // #5608 — the turn's clock, started when this panel OBSERVES the flip into working. A panel
  // mounted mid-turn undercounts (elapsed-since-seen) rather than guessing a start it never saw.
  const [turnSeenAt, setTurnSeenAt] = useState<number | null>(null);
  useEffect(() => { setTurnSeenAt(working ? Date.now() : null); }, [working]);
  const [, tickNow] = useState(0);
  useEffect(() => {
    if (!working) return;
    const iv = setInterval(() => tickNow(n => n + 1), 1000);
    return () => clearInterval(iv);
  }, [working]);
  const ticker = tickerText(status, turnSeenAt != null ? Date.now() - turnSeenAt : null,
    lastToolLabel(chat.turns), chat.meta.context.tokens);
  const liveness = sessionLiveness(status, target);
  const side = dock === "right";
  const hosted = dock === "pane";

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

  /** "Keep going" parks the offer at the frac it was said at (#5509 W1) — persisted, so neither
   *  a restart nor a rerender re-asks an answered question; bannerVisible re-offers once context
   *  has grown one more episode-step. */
  const keepGoing = () => {
    const at = chat.meta.context.frac;
    if (at === null) return;
    setDismissedAt(at);
    saveDismissedAt(at);
    setBannerArmedAt(null);
    autoHandoffKey.current = null;
  };

  const addDivider = useCallback((text: string) => {
    setChat(s => ({
      ...s,
      turns: [...s.turns, { role: "system", blocks: [{ kind: "divider", text }] }],
    }));
  }, []);

  // reason values are the CONTRACT with lib.rs HANDOFF_REASONS ("clicked"|"countdown"|
  // "unattended") — the rust side REJECTS anything else, so a rename here is a broken banner,
  // not a cosmetic choice. Caught live at integration: the seats shipped "button"/"long-run"
  // and every hand-off would have errored at the seam.
  const startHandoff = useCallback((reason: "clicked" | "countdown" | "unattended") => {
    if (handoffBusy) return;
    setHandoffBusy(true);
    setHandoffError(null);
    if (reason === "countdown") addDivider("handoff countdown expired - handing off now");
    if (reason === "unattended") addDivider("full auto reached the handoff threshold - handing off now");
    invokeFn<string>("handoff_now", { project, reason })
      .catch(e => setHandoffError(String(e)))
      .finally(() => setHandoffBusy(false));
  }, [addDivider, handoffBusy, project]);

  const bannerOffered = !history && bannerVisible(chat.meta.context.frac, dismissedAt);
  useEffect(() => {
    if (!bannerOffered || longRun) { setBannerArmedAt(null); return; }
    setBannerArmedAt(at => at ?? Date.now());
  }, [bannerOffered, longRun]);
  useEffect(() => {
    if (!bannerOffered || longRun) return;
    setBannerNow(Date.now());
    const iv = setInterval(() => setBannerNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, [bannerOffered, longRun]);
  const countdown = bannerCountdown(chat.meta.context.frac, bannerArmedAt, bannerNow);
  useEffect(() => {
    if (!countdown.expired) return;
    const key = `${project}:countdown:${bannerArmedAt ?? 0}`;
    if (autoHandoffKey.current === key) return;
    autoHandoffKey.current = key;
    startHandoff("countdown");
  }, [bannerArmedAt, countdown.expired, project, startHandoff]);
  useEffect(() => {
    if (!bannerOffered || !longRun) return;
    const key = `${project}:long-run:${chat.meta.context.frac ?? 0}`;
    if (autoHandoffKey.current === key) return;
    autoHandoffKey.current = key;
    startHandoff("unattended");
  }, [bannerOffered, chat.meta.context.frac, longRun, project, startHandoff]);

  // CSS custom properties have no key in React's CSSProperties, so the variable is declared as
  // part of the object's own type — an intersection, not an assertion: every key is checked.
  const rootStyle: CSSProperties & Record<"--chat-scale", string> = {
    "--chat-scale": String(fontScale(fontStep)),
  };
  // hosted in the pane: the pane owns both dimensions, so neither is set here
  if (!hosted && side) rootStyle.width = `${panel.width ?? 420}px`;
  if (!hosted && !side) rootStyle.height = `${panel.height ?? 340}px`;

  return (
    <div
      ref={root}
      style={rootStyle}
      className={`relative flex min-h-0 flex-col border-tr-edge bg-tr-bg ${hosted ? "flex-1" : side ? "h-full shrink-0 border-l" : "shrink-0 border-t"}`}
    >
      {/* The inner edge, as a grab strip (#5522): left when the panel is docked right, top when
          it is docked bottom. touch-none so a touch drag resizes instead of scrolling. */}
      {!hosted && <div
        role="separator"
        aria-orientation={side ? "vertical" : "horizontal"}
        aria-label={side ? "Resize chat width" : "Resize chat height"}
        title="Drag to resize"
        onPointerDown={startDrag}
        style={{ touchAction: "none" }}
        className={side
          ? "absolute inset-y-0 left-0 z-10 w-[5px] cursor-col-resize hover:bg-white/[0.06]"
          : "absolute inset-x-0 top-0 z-10 h-[5px] cursor-row-resize hover:bg-white/[0.06]"}
      />}
      {/* One row that cannot wrap. Every part is shrink-0 except the project name, which truncates,
          because a header that reflows into three lines is what "mangled" looked like. */}
      <div className="flex shrink-0 items-center gap-2 overflow-hidden px-3 py-2">
        <span className="shrink-0 text-[12.5px] font-semibold">{history ? "Claude session" : "Orchestrator"}</span>
        <span className="tr-mono min-w-0 flex-1 truncate text-[11px] text-tr-muted">{history ? sessionId : project}</span>
        {/* Reported by the session, never asserted. The context gauge moved out of this header
            to the composer bar (#5521), where the dials that fill the window live. */}
        {chat.meta.model && <span className="tr-chip shrink-0 text-[10.5px]">{chat.meta.model}</span>}
        <div className="flex shrink-0 items-center gap-1">
          {/* #5643: the manual baton — same chain as the banner's [Hand off now] (reason
              "clicked"), offered without waiting for the gauge. Busy/error surface through the
              banner's shared state. */}
          {target && !history && (
            <button
              type="button"
              onClick={() => startHandoff("clicked")}
              disabled={handoffBusy}
              title="Hand off now — write the handoff, restart the pane fresh, the successor recaps"
              className="rounded-[7px] px-2 py-1.5 text-[11px] text-tr-muted hover:text-tr-text disabled:opacity-50"
            >
              hand off
            </button>
          )}
          {/* The dock toggle says what it is (#5521): an icon that reads as the target dock,
              not a mystery square. Hosted in the pane, the mode rail IS the dock control. */}
          {!hosted && <button
            type="button"
            onClick={() => onDock(side ? "bottom" : "right")}
            title={side ? "Dock chat to bottom" : "Dock chat to right"}
            className="rounded-[7px] p-1.5 text-tr-muted hover:text-tr-text"
          >
            {side ? <PanelBottom size={13} strokeWidth={1.75} /> : <PanelRight size={13} strokeWidth={1.75} />}
          </button>}
          {/* No bare ✕ (#5521): hiding is a labeled action whose undo is named right here, so
              closing the chat never becomes a dismissal you need prior knowledge to reverse. */}
          {!hosted && <button
            type="button"
            onClick={onClose}
            title="Hide chat — the Orchestrator button in the corner brings it back"
            className="flex items-center gap-1 rounded-[7px] px-2 py-1.5 text-[11px] text-tr-muted hover:text-tr-text"
          >
            {side ? <PanelRightClose size={13} strokeWidth={1.75} /> : <PanelBottomClose size={13} strokeWidth={1.75} />}
            hide
          </button>}
          {hosted && history && (
            <button type="button" onClick={onClose} title="Back to session history"
              className="flex items-center gap-1 rounded-[7px] px-2 py-1.5 text-[11px] text-tr-muted hover:text-tr-text">
              <ArrowLeft size={13} strokeWidth={1.75} />
              back
            </button>
          )}
        </div>
      </div>

      {/* #5608 — the live turn ticker: a working turn visibly chews (elapsed · current tool ·
          context eaten), all from rows already streaming. Absent when idle: the missing line
          IS the idle state, never dead chrome. The changing text is the motion — no animation. */}
      {ticker && (
        <div className="flex shrink-0 items-center gap-1.5 px-3 pb-1.5">
          <span className="tr-dot shrink-0"
            style={{ background: status === "blocked" ? "var(--color-tr-warn)" : "var(--color-tr-doing)", width: 6, height: 6 }} />
          <span className="tr-mono min-w-0 truncate text-[10.5px] text-tr-muted">{ticker}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {!target && (
          <div className="tr-card-ghost px-4 py-3 text-[length:calc(12px*var(--chat-scale,1))] leading-relaxed">
            No orchestrator session is hosted for this project yet. Open one from the Workspace lens
            and this becomes the conversation with it.
          </div>
        )}
        {/* The "session continued" divider is a TURN now (#5646): applySessionChanged keeps the
            predecessor thread and appends a divider item, so a second panel-level rule here would
            draw the same line twice. */}
        {target && !chat.turns.length && !chat.continued && !error && (
          <div className="px-1 py-2 text-[length:calc(12px*var(--chat-scale,1))] leading-relaxed text-tr-muted">
            {history
              ? "Nothing renderable was written to this session transcript."
              : "Nothing said yet. Type below and it reaches the session exactly as if you had typed it in the terminal."}
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
                    className={`rounded-lg px-3 py-2 text-[length:calc(12.5px*var(--chat-scale,1))] leading-relaxed ${
                      t.role === "user"
                        ? "whitespace-pre-wrap break-words bg-tr-panel"
                        : "break-words bg-black/25"
                    }`}
                  >
                    {/* #6005: the operator reads the terminal because assistant replies showed
                        literal markdown. Assistant text renders as markdown; user turns are exactly
                        what was typed, so they keep the pre-wrap bubble. */}
                    {t.role === "user"
                      ? b.text
                      : <MarkdownText text={b.text} />}
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
      {!history && <div className="shrink-0 border-t border-tr-edge">
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
            <TermView project={project} agent="orchestrator" deps={TRAY_DEPS} />
          </div>
        )}
      </div>}

      {error && <div className="tr-mono px-3 pb-1 text-[11px] text-tr-fail">{error}</div>}

      {/* The banner sits ABOVE the composer (#5509 W1): it is the last thing said before the
          words you are about to type, at the moment the window it types into is running out. The
          guard proves frac is known, so the ?? 0 below only satisfies the type. */}
      {bannerOffered && !longRun && (
        <HandoffBanner
          frac={chat.meta.context.frac ?? 0}
          countdown={countdown}
          busy={handoffBusy}
          error={handoffError}
          onKeepGoing={keepGoing}
          onHandOffNow={() => startHandoff("clicked")}
        />
      )}

      {/* Suggested replies (#5929): one-click answers read from the orchestrator's recent turns.
          A click sends the text as a NORMAL user turn — receipts intact. */}
      {chipsVisible && (
        <SuggestionChips
          suggestions={suggestions}
          onPick={text => setActiveSuggestion(text)}
          onDismiss={() => setChipsDismissed(true)}
        />
      )}

      {!history && <ComposerView
        project={project}
        target={target}
        live={liveness.live}
        liveWhy={liveness.why}
        model={pending || chat.meta.model}
        modelSource={pending ? "dispatched" : modelSource}
        working={working}
        userTexts={
          // The RAW receipt channel (gap five): the record proves arrival, the display filters
          // it — bash-input rows, /compact records and isMeta rows all vanish from turns yet
          // all confirm a send. Display turns remain the fallback for an older backend that
          // does not emit receiptTexts yet.
          chat.receiptTexts.length
            ? chat.receiptTexts
            : chat.turns.filter(t => t.role === "user").map(t => t.blocks.filter(b => b.kind === "text").map(b => b.text).join("\n"))
        }
        context={chat.meta.context}
        fontStep={fontStep}
        onFontStep={pickFont}
        onSent={sync}
        onLongRunChange={setLongRun}
        onDispatch={(dial, value) => { if (dial === "model") { setPending(value); setModelSource("dispatched"); } }}
        onDraftChange={setComposerDraft}
        suggestion={activeSuggestion}
        onSuggestionHandled={() => setActiveSuggestion(null)}
      />}
    </div>
  );
}
