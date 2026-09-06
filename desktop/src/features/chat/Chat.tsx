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
import { suggestionsFromAskOptions, suggestionsFromTurns } from "./suggestions";
import { SuggestionChips } from "./SuggestionChips";
import {
  clampPanel, fontScale, loadDismissedAt, loadFontStep, loadPanelSize, loadTrayOpen,
  saveDismissedAt, saveFontStep, savePanelSize, saveTrayOpen, type FontStep,
} from "./prefs";
import {
  answerKeystrokes, applyBackfill, applyRows, applySessionChanged, bannerVisible, DOWN_ARROW, emptyChat, isDividerTurn,
  lastToolLabel, sessionLiveness, tickerText,
  type AskQuestion, type Backfill, type Block, type ChatState, type OpenQuestion, type RowsPayload,
  type SessionPayload, type ToolResult, type Turn,
} from "./streaming";
import {
  apply as applyStatus, initialArbiterState, needsReseed, RESEED_DELAYS_MS,
  type ArbiterState, type StatusSource,
} from "./statusArbiter";
import { WAKE_PENDING_LINE, WAKE_OUTCOME_MS } from "../genesis/wakeRow";
import { wakeProgressText, WAKE_PROGRESS_EVENT, type WakeProgress } from "../genesis/wakeProgress";

/** "pane" = hosted inside the ModePane (#5841): the pane owns width, height, and the mode
 *  rail, so the chat brings no column chrome of its own — no fixed width, no resize strip, no
 *  dock/hide buttons. Rendering the dock chrome inside the pane made the chat taller than its
 *  host (h-full + rail + footer) and wider than 440 (the saved dock width), so focusing the
 *  composer scrolled the rail out of the clipped container: "no way to change it back". */
export type Dock = "right" | "bottom" | "pane";

/** chat_watch's return shape (#6113): `current` is the tail cursor at seed time, `generation` is
 *  the token chat_unwatch must echo back so a stale unwatch can't stop a fresher watcher sharing
 *  the same project:session key. */
type ChatWatchResult = { current: number; generation: number };

type OrchAsk = {
  project: string;
  session_id: string;
  tool_use_id: string | null;
  open: boolean;
  visible: boolean;
  questions: AskQuestion[];
};
type LiveAsk = OrchAsk & { target: string | null };

const askKey = (ask: Pick<OrchAsk, "session_id" | "tool_use_id">) =>
  `${ask.session_id}\u0000${ask.tool_use_id ?? ""}`;

function sameAskQuestions(left: AskQuestion[], right: AskQuestion[]): boolean {
  return left.length === right.length && left.every((question, index) => {
    const other = right[index];
    return Boolean(other) && question.header === other.header && question.question === other.question &&
      question.multiSelect === other.multiSelect && question.options.length === other.options.length &&
      question.options.every((option, optionIndex) => option.label === other.options[optionIndex]?.label &&
        option.description === other.options[optionIndex]?.description);
  });
}

function transcriptAnswered(ask: OrchAsk, chat: ChatState): boolean {
  if (ask.tool_use_id) return Boolean(chat.results[ask.tool_use_id]);
  return chat.turns.some(turn => turn.blocks.some(block =>
    block.tool === "AskUserQuestion" && Boolean(block.tool_id && chat.results[block.tool_id]) &&
    Boolean(block.ask && sameAskQuestions(block.ask, ask.questions)),
  ));
}

/** Consecutive turns from the same speaker are ONE thing to a reader. The transcript splits them
 *  every time a tool runs, which is why the panel showed "ORCHESTRATOR" stacked above every card. */
/** Consecutive tool blocks become one array; everything else passes through. An AskUserQuestion
 *  never joins (or absorbs) a neighbour (#6094, 2026-09-05): ToolRun collapses any array longer
 *  than 1 behind a closed-by-default "N tools" toggle, and an orchestrator that checks something
 *  then asks in the same breath — no thinking/text block between the two tool calls — used to
 *  batch its ask right into that collapsed run, hiding the one card the operator must act on
 *  behind a bar that read "2 tools". Keeping every ask its own singleton routes it through
 *  ToolRun's `blocks.length === 1` path straight to AskCard, regardless of what tool call sits
 *  next to it. */
function batch(blocks: Block[]): Array<Block | Block[]> {
  const out: Array<Block | Block[]> = [];
  const isAsk = (b: Block) => b.kind === "tool" && b.tool === "AskUserQuestion";
  for (const b of blocks) {
    if (isAsk(b)) { out.push([b]); continue; }
    const last = out[out.length - 1];
    if (b.kind === "tool") {
      if (Array.isArray(last) && !(last.length === 1 && isAsk(last[0]))) last.push(b);
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
function ToolRun({ blocks, results }: {
  blocks: Block[]; results: Record<string, ToolResult>;
}) {
  const [open, setOpen] = useState(false);
  const failed = blocks.filter(b => b.tool_id && results[b.tool_id] && !results[b.tool_id].ok).length;
  const running = blocks.filter(b => !b.tool_id || !results[b.tool_id]).length;
  if (blocks.length === 1) {
    return <ToolCard block={blocks[0]} result={blocks[0].tool_id ? results[blocks[0].tool_id] : undefined} />;
  }
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
  if (block.tool === "AskUserQuestion" && block.ask && block.tool_id && result) {
    return <AskCard tool_id={block.tool_id} questions={block.ask} result={result} target={null} onAnswer={async () => {}} />;
  }
  if (block.tool === "AskUserQuestion") return null;
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

/** The question card (#6094): an AskUserQuestion tool_use rendered as something the operator can
 *  actually answer, instead of a collapsed "AskUserQuestion running" row. Answered (once the
 *  transcript's tool_result lands — never asserted locally) shows the recorded choice, same as
 *  ToolCard shows any other finished call; open shows buttons per option, a multi-select tray
 *  when the question asks for one, and an Other free-text row. A click writes keystrokes into
 *  the pane hosting that event's session rather than claiming success itself — the card reflects
 *  what the transcript says happened. */
function AskCard({ tool_id, questions, result, target, visible = true, onAnswer }: {
  tool_id: string | null; questions: AskQuestion[]; result?: ToolResult;
  target: string | null; visible?: boolean;
  onAnswer: (toolId: string | null, data: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [otherText, setOtherText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One question per AskUserQuestion call is the overwhelming case; render every one the tool
  // actually sent rather than assuming there is exactly one.
  const q = questions[0];
  if (!q) return null;

  if (result) {
    return (
      <div data-testid="ask-card" className="mt-1.5 rounded-lg border border-tr-edge bg-black/20 px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[length:calc(11.5px*var(--chat-scale,1))] font-medium">
          <span>{q.header || "Question"}</span>
          <span className="shrink-0 text-[10.5px] font-normal text-tr-muted">answered</span>
        </div>
        <div className="text-[length:calc(11.5px*var(--chat-scale,1))] text-tr-muted">{result.preview || q.question}</div>
      </div>
    );
  }

  const send = async (data: string) => {
    if (!target || !visible || busy) return;
    setBusy(true); setError(null);
    try {
      await onAnswer(tool_id, data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickSingle = (i: number) => { void send(answerKeystrokes(q, [i])); };
  const toggleMulti = (i: number) => {
    setPicked(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  };
  const submitMulti = () => { void send(answerKeystrokes(q, [...picked])); };
  const submitOther = () => {
    if (!otherText.trim()) return;
    // "Type something" is the picker's own always-appended free-text option, one row past the
    // model's own list — walk Down to it the same way answerKeystrokes reaches any other row,
    // Enter opens its text input, then the text and its own Enter (#6094; see answerKeystrokes'
    // doc comment for the evidence behind the arrow-navigation contract).
    void send(`${DOWN_ARROW.repeat(q.options.length)}\r${otherText}\r`);
  };

  return (
    <div data-testid="ask-card" className="mt-1.5 rounded-lg border border-tr-warn/40 bg-tr-warn/5 px-2.5 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[length:calc(11.5px*var(--chat-scale,1))] font-medium">
        <span className="tr-dot shrink-0" style={{ background: "var(--color-tr-warn)", width: 6, height: 6 }} />
        <span>{q.header || "Question"}</span>
        {q.multiSelect && <span className="shrink-0 text-[10.5px] font-normal text-tr-muted">pick any</span>}
      </div>
      <div className="mb-2 text-[length:calc(12px*var(--chat-scale,1))] leading-relaxed">{q.question}</div>
      <div className="flex flex-col gap-1">
        {q.options.map((opt, i) => (
          <button
            key={i}
            type="button"
            disabled={!target || !visible || busy}
            onClick={() => q.multiSelect ? toggleMulti(i) : pickSingle(i)}
            className="flex items-start gap-1.5 rounded-lg border border-tr-edge bg-black/20 px-2.5 py-1.5 text-left disabled:opacity-50"
          >
            {q.multiSelect && (
              <span
                className="mt-0.5 h-3 w-3 shrink-0 rounded-[3px] border border-tr-edge"
                style={{ background: picked.has(i) ? "var(--color-tr-warn)" : "transparent" }}
              />
            )}
            <span className="min-w-0 flex-1">
              <div className="text-[length:calc(11.5px*var(--chat-scale,1))] font-medium">{opt.label}</div>
              {opt.description && (
                <div className="text-[length:calc(11px*var(--chat-scale,1))] text-tr-muted">{opt.description}</div>
              )}
            </span>
          </button>
        ))}
      </div>
      {q.multiSelect && (
        <button
          type="button"
          disabled={!target || !visible || busy || picked.size === 0}
          onClick={submitMulti}
          className="mt-1.5 rounded-[8px] bg-tr-panel px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
        >
          Submit {picked.size || ""}
        </button>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          type="text"
          value={otherText}
          onChange={e => setOtherText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submitOther(); }}
          disabled={!target || !visible || busy}
          placeholder="Other — type an answer"
          className="min-w-0 flex-1 rounded-[8px] border border-tr-edge bg-black/20 px-2 py-1 text-[11.5px] disabled:opacity-50"
        />
        <button
          type="button"
          disabled={!target || !visible || busy || !otherText.trim()}
          onClick={submitOther}
          className="shrink-0 rounded-[8px] bg-tr-panel px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-40"
        >
          Send
        </button>
      </div>
      {!target && (
        <div className="mt-1.5 text-[10.5px] text-tr-muted">No pane hosts this session — answer it in its terminal.</div>
      )}
      {target && !visible && (
        <div className="mt-1.5 text-[10.5px] text-tr-muted">Waiting for the terminal question picker…</div>
      )}
      {error && <div className="tr-mono mt-1.5 text-[10.5px] text-tr-fail">{error}</div>}
    </div>
  );
}

function LiveAskCard({ ask, onAnswer, invokeFn }: {
  ask: LiveAsk;
  onAnswer: (ask: LiveAsk, data: string) => Promise<void>;
  invokeFn: ChatDeps["invoke"];
}) {
  useEffect(() => {
    const ts = Date.now();
    void invokeFn("app_log", {
      line: `ask card mounted session=${ask.session_id} tool=${ask.tool_use_id ?? "null"} ts=${ts}`,
    }).catch(() => {});
  }, [ask.session_id, ask.tool_use_id, invokeFn]);
  useEffect(() => {
    if (!ask.visible) return;
    const ts = Date.now();
    void invokeFn("app_log", {
      line: `ask buttons enabled session=${ask.session_id} tool=${ask.tool_use_id ?? "null"} ts=${ts}`,
    }).catch(() => {});
  }, [ask.visible, ask.session_id, ask.tool_use_id, invokeFn]);
  return (
    <AskCard
      tool_id={ask.tool_use_id}
      questions={ask.questions}
      target={ask.target}
      visible={ask.visible}
      onAnswer={(_toolId, data) => onAnswer(ask, data)}
    />
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
  /** Answers an AskUserQuestion card by writing its keystrokes into the pane (#6094) — the same
   *  path the live terminal's keyboard uses, not the prompt path (`pane_send` refuses while
   *  blocked). Its own seam so a test can assert what a click sent without a real pty. */
  answerAtSession: (sessionId: string, data: string) => Promise<void>;
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
  answerAtSession: (sessionId, data) => invoke("ask_answer_session", { sessionId, data }),
  Composer,
  TerminalPane,
};

/** An orch-status payload arrives as the emitter's OrchStatusPayload object; a string is the test
 *  harness's shape (Chat's `deps.listen` fake, unlike Tauri's real one, hands events through as
 *  whatever `JSON.stringify` the test wrote — never a live object). */
type OrchStatusFields = { project?: unknown; status?: unknown };
type OrchStatusRaw = string | OrchStatusFields;
type OrchStatusDecoded = { project: string; status: string };
function decodeOrchStatus(payload: OrchStatusRaw): OrchStatusDecoded {
  // SAFETY: a string payload is always this same {project,status} shape JSON-encoded (the test
  // harness's fake `listen`); both fields are re-checked below before use, and a wrong shape falls
  // through to the empty-string default rather than being trusted.
  const obj: OrchStatusFields = payload instanceof Object ? payload : (JSON.parse(payload) as OrchStatusFields);
  return { project: String(obj.project ?? ""), status: String(obj.status ?? "") };
}

export function Chat({ project, sessionId, dock, onDock, onClose, deps = DEFAULT_CHAT_DEPS }: {
  project: string; sessionId?: string; dock: Dock; onDock: (d: Dock) => void; onClose: () => void;
  /** Test seam — production callers omit it and get the real modules. */
  deps?: ChatDeps;
}) {
  const { invoke: invokeFn, listen: listenFn, orchestratorOf: paneOf, Composer: ComposerView, TerminalPane: TermView } = deps;
  const history = Boolean(sessionId);
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [liveAsks, setLiveAsks] = useState<Record<string, LiveAsk>>({});
  const chatRef = useRef(chat);
  chatRef.current = chat;
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
  // #6146 — status has two sources racing (a one-shot seed and a stream of pushes), and a late
  // seed stomping a fresher push is exactly the bug: pr-os's pane pushed "working" while the
  // composer stayed disabled on a seed that resolved to "none" after the fact. arbiterRef mirrors
  // `status` but additionally remembers the seq of whichever event produced it, so a late arrival
  // can be told apart from a genuinely newer one (statusArbiter.ts). seqRef mints that seq: a
  // seed's is assigned at DISPATCH (before its promise settles), a push's at ARRIVAL — never at
  // resolution — so ordering reflects when the truth was actually known, not when React heard back.
  const arbiterRef = useRef<ArbiterState>(initialArbiterState);
  const seqRef = useRef(0);
  const nextSeq = useCallback(() => seqRef.current++, []);
  // Apply one candidate status and log it — every commit, applied or dropped, so a genesis drill
  // can read the ordering straight out of app-trace.log instead of guessing at it again.
  const commitStatus = useCallback((source: StatusSource, seq: number, value: string) => {
    const next = applyStatus(arbiterRef.current, { source, seq, value });
    const applied = next !== arbiterRef.current;
    if (applied) { arbiterRef.current = next; setStatus(next.value); }
    invokeFn("app_log", {
      line: `chat status ${project}: ${source}=${value} (seq ${seq})${applied ? "" : ` dropped stale, effective=${arbiterRef.current.value}`}`,
    }).catch(() => {});
  }, [project, invokeFn]);
  // True once the watcher is feeding us events; false means the 2s poll IS the transport.
  const [streamed, setStreamed] = useState(false);
  // What the session REPORTED, versus what we sent and have not seen confirmed.
  const [modelSource, setModelSource] = useState<Provenance>("unknown");
  const [pending, setPending] = useState<string>("");
  const foot = useRef<HTMLDivElement | null>(null);
  // The decision cursor: updated synchronously where the state is updated asynchronously, so two
  // arrivals in one tick still see the cursor the first one left.
  const seenRef = useRef(0);
  const syncRef = useRef<() => Promise<void>>(() => Promise.resolve());
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
    setChat(emptyChat); setLiveAsks({}); seenRef.current = 0; setError(null);
    // A new mount/switch owes nothing to the last episode's seq clock (#6146) — reset the
    // arbiter before the first commit of this episode so an in-flight commit from the PREVIOUS
    // project can never be mistaken for a newer one here.
    arbiterRef.current = initialArbiterState;
    seqRef.current = 0;
    commitStatus("seed", nextSeq(), "unknown");
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

  // The hook sidecar is the live authority for a pending question (#6533). Subscribe BEFORE
  // asking Rust to watch: ask_watch replays files already present, which is how a cold Chat tab
  // receives an ask that opened while another lens was visible.
  useEffect(() => {
    if (history) return;
    let alive = true;
    let off: (() => void) | null = null;
    const visibilityTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const listener = listenFn<OrchAsk>("orch-ask", event => {
      const ask = event.payload;
      const ts = Date.now();
      void invokeFn("app_log", {
        line: `ask event in webview session=${ask.session_id} open=${ask.open} visible=${ask.visible} tool=${ask.tool_use_id ?? "null"} ts=${ts}`,
      }).catch(() => {});
      if (!alive || ask.project !== project) return;
      const key = askKey(ask);
      if (!ask.open) {
        const timer = visibilityTimers.get(key);
        if (timer) clearTimeout(timer);
        visibilityTimers.delete(key);
        setLiveAsks(current => {
          if (!current[key]) return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
        return;
      }
      if (transcriptAnswered(ask, chatRef.current)) return;
      if (ask.visible) {
        const timer = visibilityTimers.get(key);
        if (timer) clearTimeout(timer);
        visibilityTimers.delete(key);
        void invokeFn("app_log", {
          line: `ask visible session=${ask.session_id} via=permission-request ts=${ts}`,
        }).catch(() => {});
      } else if (!visibilityTimers.has(key)) {
        visibilityTimers.set(key, setTimeout(() => {
          visibilityTimers.delete(key);
          if (!alive) return;
          const fallbackTs = Date.now();
          setLiveAsks(current => current[key]
            ? { ...current, [key]: { ...current[key], visible: true } }
            : current);
          void invokeFn("app_log", {
            line: `ask visible session=${ask.session_id} via=fallback ts=${fallbackTs}`,
          }).catch(() => {});
        }, 1_500));
      }
      setLiveAsks(current => {
        const existing = current[key];
        return { ...current, [key]: { ...ask, target: existing?.target ?? null } };
      });
      invokeFn<string | null>("ask_target", { sessionId: ask.session_id }).then(answerTarget => {
        if (!alive) return;
        setLiveAsks(current => current[key]
          ? { ...current, [key]: { ...current[key], target: answerTarget } }
          : current);
      }).catch(() => {});
    });
    listener.then(unlisten => {
      if (!alive) { unlisten(); return; }
      off = unlisten;
      invokeFn("ask_watch").catch(error => setError(String(error)));
    }).catch(error => setError(String(error)));
    return () => {
      alive = false;
      off?.();
      for (const timer of visibilityTimers.values()) clearTimeout(timer);
    };
  }, [history, project, invokeFn, listenFn]);

  // #6094, 0.3.146 — sync() can be asked for concurrently from several INDEPENDENT sources: the
  // chat_watch effect's own unconditional call at mount, its "watch.current > seenRef.current"
  // gap-check, a chat-rows cursor-mismatch resync, and a plain handoff-backward restart. None of
  // them know about each other. A large real transcript's
  // decode round trip (read_chat_snapshot walks the whole file twice) can outlast a 300ms retry
  // interval, so two independently-dispatched calls both capture the same stale cursor and each
  // looks "stale" to the other once it resolves — re-triggering forever without ever reaching
  // the success path that absorbs a batch (observed on the real transcript: 15 retries over 8s,
  // never found an ask that had been on disk the whole time). One fetch in flight at a time,
  // globally: a request that arrives mid-flight marks `pending` and returns immediately; the
  // in-flight call's own completion picks it up.
  const syncBusyRef = useRef(false);
  const syncPendingRef = useRef(false);
  /** Fetch everything past the cursor and fold it in. This is the backfill, the mismatch repair
   *  and the post-send refresh — one path, so they cannot disagree. */
  const sync = useCallback((): Promise<void> => {
    if (syncBusyRef.current) {
      syncPendingRef.current = true;
      return Promise.resolve();
    }
    syncBusyRef.current = true;
    const after = seenRef.current;
    return invokeFn<string>("orchestrator_chat", { project, after, sessionId: sessionId ?? null })
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
        // #6094 — a second sync() can dispatch before this one resolves: the chat_watch effect
        // tears down and re-runs the instant `target` moves from null to a live pane (#5495), and
        // its own unconditional sync() at the top races whatever this call already had in
        // flight, both captured with the SAME stale `after`. Landing this call while the OTHER
        // one already moved the cursor forward is not automatically "subsumed" — applyBackfill's
        // own mismatch guard only bumps the cursor and drops `fresh` untouched, which is correct
        // when this call saw nothing past what already landed, but silently discards live rows
        // (an AskUserQuestion, 2026-09-05 — status went blocked, nothing rendered, ever, because
        // the cursor jumped past the ask and no future sync() ever asks for it again) when this
        // call actually reached further than the other one did. Re-sync from wherever the cursor
        // NOW sits instead of guessing how to merge two overlapping reads.
        if (seenRef.current !== after) {
          if (b[2] > seenRef.current) syncRef.current();
          return;
        }
        seenRef.current = b[2];
        setChat(s => applyBackfill(s, b, after));
        setError(null);
      })
      .catch(e => setError(String(e)))
      .finally(() => {
        syncBusyRef.current = false;
        if (syncPendingRef.current) {
          syncPendingRef.current = false;
          void sync();
        }
      });
  }, [project, sessionId]);
  syncRef.current = sync;

  useEffect(() => {
    let alive = true;
    const offs: Array<() => void> = [];
    let badFrames = 0;
    setStreamed(false);
    // #6094 — the cleanup below must echo THIS instance's OWN generation back to chat_unwatch,
    // never a snapshot taken too early: if `target` resolves (null -> a live pane, #5495) fast
    // enough that this effect tears down before its OWN chat_watch call has resolved, reading a
    // ref synchronously at cleanup time finds it still undefined even though a Rust-side watcher
    // for THIS instance may already exist — sending chat_unwatch the generation-less fallback,
    // which removes WHATEVER entry is live for the key unconditionally (#6113's own
    // "unconditional-removal" description). If the next mount's chat_watch has by then already
    // installed ITS watcher under the same key, this stale unconditional unwatch kills it too —
    // leaving a live "orch-status" listener with no Rust thread left to ever push it a frame
    // again (silent from then on: no backfill call, no trace, nothing — the 09-05 18:37 real-path
    // failure). `generation` resolves to this instance's own chat_watch answer (or undefined if
    // it never got one), and cleanup AWAITS it — so the unwatch it sends is always this
    // instance's true identity, never a guess.
    let resolveGeneration: (g: number | undefined) => void = () => {};
    const generationPromise = new Promise<number | undefined>(resolve => { resolveGeneration = resolve; });
    // The contract keeps the initial whole-file read on orchestrator_chat; the watcher takes over
    // from there. Until it can (its command missing on an older build, or no session yet), the
    // poll below is the transport this view has always had.
    sync();
    void (async () => {
      try {
        // #6146 — the "orch-status" listener is registered, and its registration AWAITED, BEFORE
        // chat_watch is invoked below. chat_watch is what spawns the Rust status watcher thread
        // (spawn_status_watcher, lib.rs), and that thread emits its first frame within
        // microseconds of chat_watch returning — the same event-registration race fixed for the
        // LSP transport (lspTransport.ts's TauriMessageReader). A listener wired up AFTER the
        // invoke can miss that very first push outright; the bounded re-seed schedule below is
        // the belt for whatever this ordering fix still lets slip through.
        if (!history) {
          offs.push(await listenFn<OrchStatusRaw>("orch-status", ev => {
            // #6094, 0.3.148/149 — the LIVE push emitted "ok=true" on the Rust side (confirmed
            // via app-trace) with NOT ONE "chat status ...: push=..." line following it — meaning
            // commitStatus was never even called, and this listener's own silent `catch {}` and
            // silent "project didn't match" fall-through were both indistinguishable from "the
            // event never arrived at all". Every arrival now traces itself, so the next real
            // bounce names exactly which of the four outcomes (dead listener / not-alive /
            // parse failure / project mismatch) actually happened instead of leaving zero
            // evidence for the one push that matters most (the one Chat never acted on).
            if (!alive) {
              void invokeFn("app_log", { line: `chat orch-status received but listener not alive: project=${project} raw=${ev.payload}` }).catch(() => {});
              return;
            }
            try {
              // SAFETY: payload comes from our own Rust emitter (orch-status), and both fields
              // are re-checked before use — a malformed payload falls through the guard or catch.
              // The Rust emitter sends a serialized struct, which Tauri hands the listener as an
              // OBJECT; only the tests ever sent a string. Parsing an object threw on every live
              // frame (#6094, the 0.3.148 trace: "FAILED to parse ... raw=[object Object]").
              const p = decodeOrchStatus(ev.payload);
              if (p.project === project && p.status) {
                commitStatus("push", nextSeq(), p.status);
              } else {
                void invokeFn("app_log", {
                  line: `chat orch-status received but did not match: expected project=${project}, got project=${p.project} status=${p.status}`,
                }).catch(() => {});
              }
            } catch (e) {
              void invokeFn("app_log", {
                line: `chat orch-status FAILED to parse: project=${project} raw=${ev.payload} error=${e instanceof Error ? e.message : String(e)}`,
              }).catch(() => {});
            }
          }));
        }
        const watch = await invokeFn<ChatWatchResult>("chat_watch", { project, sessionId: sessionId ?? null });
        // Resolved unconditionally, even if `alive` already flipped false: cleanup may be
        // waiting on exactly this promise to learn what to unwatch.
        resolveGeneration(watch.generation);
        if (!alive) return;
        // Rows that landed while the watcher was spinning up would otherwise sit between our
        // cursor and the first event's after — close the gap now.
        if (watch.current > seenRef.current) sync();
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
              const seq = nextSeq();
              invokeFn<string>("orchestrator_status", { project })
                .then(st => { if (alive && st) commitStatus("seed", seq, st); })
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
            const seq = nextSeq();
            invokeFn<string>("orchestrator_status", { project })
              .then(st => { if (alive && st) commitStatus("seed", seq, st); })
              .catch(() => {});
          } catch { if (++badFrames >= 3) setStreamed(false); }
        }));
        if (alive) setStreamed(true);
      } catch {
        // No watcher to be had — the poll fallback carries the view. chat_watch may have failed
        // before resolving at all (or never got called): nothing to unwatch, so the fallback
        // below sends the generation-less form, correctly a no-op-if-nothing-matches on the
        // Rust side rather than a false "unconditional remove".
        resolveGeneration(undefined);
      }
    })();
    return () => {
      alive = false;
      for (const off of offs) off();
      // Echo back the generation THIS instance's OWN chat_watch resolved to (#6113, #6094) —
      // awaited, never read from the ref synchronously: a mount torn down before its chat_watch
      // answered must still learn its true generation before unwatching, or it sends the
      // generation-less fallback and can kill a DIFFERENT (later) mount's live watcher instead of
      // its own (see the comment above generationPromise's declaration).
      void generationPromise.then(generation => {
        invokeFn("chat_unwatch", { project, sessionId: sessionId ?? null, generation: generation ?? null }).catch(() => {});
      });
    };
  }, [project, sessionId, target !== null, sync, history, commitStatus, nextSeq]);

  // The poll transport: runs until the watcher takes over, and again if it ever gives up.
  useEffect(() => {
    if (streamed) return;
    const iv = setInterval(sync, 2_000);
    return () => clearInterval(iv);
  }, [streamed, sync]);

  // Status is PUSHED (Phase 3): the backend holds a per-pane herdr subscription (spawned with
  // chat_watch, whose "orch-status" listener is wired in the effect above — registered before the
  // invoke, #6146) and emits on every lifecycle change. This effect owns only the SEED side: one
  // dispatch at mount paints the first state, and — recovering the exact pr-os failure, where the
  // seed resolved to "none" after a push had already landed "working" — a bounded re-seed at
  // RESEED_DELAYS_MS offsets fires only while the effective status is still closed ("none" /
  // "unknown"). Finite and self-cancelling, never a polling loop: a real status (from either
  // source) disarms every remaining timer's own check, and all timers clear on unmount/switch.
  useEffect(() => {
    if (history) { commitStatus("seed", nextSeq(), "ended"); return; }
    let alive = true;
    const dispatch = () => {
      const seq = nextSeq();
      invokeFn<string>("orchestrator_status", { project })
        .then(st => { if (alive && st) commitStatus("seed", seq, st); })
        .catch(() => {});
    };
    dispatch();
    const timers = RESEED_DELAYS_MS.map(ms => setTimeout(() => {
      if (alive && needsReseed(arbiterRef.current.value)) dispatch();
    }, ms));
    return () => { alive = false; for (const t of timers) clearTimeout(t); };
  }, [history, project, commitStatus, nextSeq]);
  useEffect(() => { foot.current?.scrollIntoView({ behavior: "smooth" }); }, [chat.turns.length]);

  const working = status === "working";

  // #6201 — the wake chain's line in this header. During the idle gate the session's own startup
  // makes status read "working" (tiny-timer: "working · 44s" across an 88s silent gate), which
  // is exactly how a woken session read as idle-with-nothing-to-do. So while a wake runs, its
  // truth REPLACES the ticker; when the chain lands, the outcome shows for the same few seconds
  // the sidebar row gives it, then the ticker returns.
  const [wakeNote, setWakeNote] = useState<{ kind: "pending" | "outcome"; text: string } | null>(null);
  useEffect(() => {
    if (history) return;
    let alive = true;
    let fade: ReturnType<typeof setTimeout> | undefined;
    const armFade = () => {
      if (fade) clearTimeout(fade);
      fade = setTimeout(() => { fade = undefined; if (alive) setWakeNote(null); }, WAKE_OUTCOME_MS);
    };
    const drop = () => { if (fade) { clearTimeout(fade); fade = undefined; } };
    setWakeNote(null);
    drop();
    // A window opened mid-wake reads the mount-time mark; events keep it current afterwards.
    invokeFn<string[]>("wake_in_progress").then(ps => {
      if (alive && (ps ?? []).includes(project)) setWakeNote({ kind: "pending", text: WAKE_PENDING_LINE });
    }).catch(() => {});
    const un = listenFn<WakeProgress>(WAKE_PROGRESS_EVENT, e => {
      if (!alive || e.payload.project !== project) return;
      const note = wakeProgressText(e.payload.phase, e.payload.detail);
      setWakeNote(note);
      if (note?.kind === "outcome") armFade();
      else drop();
    });
    return () => { alive = false; drop(); void un.then(f => f()); };
  }, [history, project, invokeFn, listenFn]);

  // A transcript result is also a close signal: Claude can omit the closing hook, but a card must
  // never remain answerable after the answer is recorded (#6533 stale-open protection).
  useEffect(() => {
    setLiveAsks(current => {
      let changed = false;
      const next: Record<string, LiveAsk> = {};
      for (const [key, ask] of Object.entries(current)) {
        if (transcriptAnswered(ask, chat)) changed = true;
        else next[key] = ask;
      }
      return changed ? next : current;
    });
  }, [chat.results]);
  const liveAskList = Object.values(liveAsks).filter(ask => ask.project === project);
  const activeLiveAsk = liveAskList[liveAskList.length - 1] ?? null;
  const openAsk: OpenQuestion | null = activeLiveAsk
    ? { tool_id: activeLiveAsk.tool_use_id ?? askKey(activeLiveAsk), questions: activeLiveAsk.questions }
    : null;
  // Suggested-reply chips (#5929): asks collected from EVERY orchestrator turn since the
  // operator's last user turn (walk back until a user turn — the real ask is routinely one turn
  // back behind a hook-driven "Nothing to swap."), most recent ask first, capped at three.
  // Purely derived (suggestions.ts — nothing invented, no LLM call). Live only while that ask
  // turn is still the last thing said (answered → gone), composer empty (typing → gone), and
  // Esc or the × dismisses until the next orchestrator turn recomputes the row.
  //
  // An open AskUserQuestion (#6094) wins over prose: its tool_use block carries the actual
  // question as structured options, not a sentence — the text extractor below only reads
  // `kind === "text"` blocks, so a turn that ends in the ask TOOL rather than typed prose (the
  // orchestrator's other and increasingly common way to ask "push?"/pick-one) fed it an empty
  // string and produced zero chips. That was the #5993 regression: not the status gate (already
  // fixed, #6215/#6201), but this extractor never having read the one place the question text
  // actually lives on a tool-shaped ask.
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
  const askQuestion = openAsk?.questions[0] ?? null;
  const suggestions = useMemo(() => {
    if (history || working) return [];
    if (askQuestion) return suggestionsFromAskOptions(askQuestion.options);
    return suggestionsFromTurns(orchestratorTexts);
  }, [history, working, askQuestion, orchestratorTexts]);
  const lastSpeechTurn = [...chat.turns].reverse().find(t => t.role === "user" || t.role === "assistant");
  const chipsVisible =
    !history && !!(activeLiveAsk?.target ?? target) && !working && suggestions.length > 0 &&
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
  const answerAsk = useCallback(async (ask: LiveAsk, data: string) => {
    if (!ask.target) throw new Error("No pane hosts this session — answer it in its terminal.");
    const clickedAt = Date.now();
    void invokeFn("app_log", {
      line: `ask answer clicked session=${ask.session_id} tool=${ask.tool_use_id ?? "null"} ts=${clickedAt}`,
    }).catch(() => {});
    try {
      await deps.answerAtSession(ask.session_id, data);
      const resolvedAt = Date.now();
      void invokeFn("app_log", {
        line: `ask answer resolved session=${ask.session_id} tool=${ask.tool_use_id ?? "null"} ts=${resolvedAt}`,
      }).catch(() => {});
      sync();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void invokeFn("app_log", {
        line: `ask answer rejected session=${ask.session_id} tool=${ask.tool_use_id ?? "null"} ts=${Date.now()} error=${message}`,
      }).catch(() => {});
      throw error;
    }
  }, [deps, invokeFn, project, sync]);
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

      {/* #6201 — a running wake's line outranks the session's own startup ticker: during the
          idle gate "working · 44s" is precisely the lie this card exists to correct. The
          outcome keeps the row for its few seconds, then the ticker returns. */}
      {wakeNote ? (
        <div className="flex shrink-0 items-center gap-1.5 px-3 pb-1.5">
          <span className="tr-dot shrink-0"
            style={{ background: wakeNote.kind === "outcome" ? "var(--color-tr-ok)" : "var(--color-tr-doing)", width: 6, height: 6 }} />
          <span className="tr-mono min-w-0 truncate text-[10.5px] text-tr-muted">{wakeNote.text}</span>
        </div>
      ) : ticker && (
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
        {target && !chat.turns.length && !liveAskList.length && !chat.continued && !error && (
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
        {liveAskList.map(ask => (
          <div key={askKey(ask)} className="mb-3">
            <div className="mb-1 text-[length:calc(10.5px*var(--chat-scale,1))] uppercase tracking-wider text-tr-muted">
              session · {ask.session_id.slice(0, 8)}
            </div>
            <LiveAskCard ask={ask} onAnswer={answerAsk} invokeFn={invokeFn} />
          </div>
        ))}
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
          A prose ask sends the text as a NORMAL user turn — receipts intact. An open AskUserQuestion
          (#6094) is a blocking terminal picker, not a chat prompt: its chip answers the SAME way the
          ask card's own option click does, by keystrokes into the pane, not a composer send. */}
      {chipsVisible && (
        <SuggestionChips
          suggestions={suggestions}
          onPick={text => {
            if (activeLiveAsk && askQuestion) {
              const idx = askQuestion.options.findIndex(o => o.label === text);
              if (idx >= 0) { void answerAsk(activeLiveAsk, answerKeystrokes(askQuestion, [idx])); return; }
            }
            setActiveSuggestion(text);
          }}
          onDismiss={() => setChipsDismissed(true)}
        />
      )}

      {!history && <ComposerView
        project={project}
        target={target}
        live={liveness.live}
        liveWhy={liveness.why}
        blockedAsk={openAsk}
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
