// The composer: attach, model, effort, send/stop.
//
// The provenance rule, taken from Orca and the reason this is not just a dropdown: you cannot KNOW
// a terminal agent's current model. You know what the transcript reported, and you know what you
// sent. So a value carries where it came from — `reported` is evidence, `dispatched` means sent and
// not yet confirmed — and the control says so rather than asserting.
//
// Both option lists come from `claude --help`, not from memory: effort is a closed list, and model
// takes documented aliases. Typing a model id from memory is a mistake this codebase has already
// paid for once.
//
// Every input is gated on LIVE, not on a pane row existing (#5477): a pane whose agent exited is
// registered but dead, and typing into it would queue words nobody will ever read. `liveWhy`
// names the reason on every locked control, because a control that explains itself is trusted.
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowUp, ChevronDown, FileText, Image as ImageIcon, Paperclip, Square, X } from "lucide-react";
import { searchFiles } from "../code/fileApi";
import { attachmentInfo } from "../../shared/api/client";
import { addChips, formatBytes, makeChip, removeChip, serializeForSend, type AttachmentChip } from "./attachments";
import { clampComposerPx, growComposerPx, loadComposerHeight, maxComposerPx, minComposerPx, saveComposerHeight } from "./composerHeight";
import { FONT_STEPS, type FontStep } from "./prefs";
import { gaugeLabel, gaugeTone, gaugeUnknownWindow, composerSlot, hasImagePath, normalizeAttachments, receiptFor, type ContextGauge, type OpenQuestion, type PendingSend } from "./streaming";
import { projectSessions, takeoverAction, type ProjectSessions } from "./takeover";
import { TakeoverStrip } from "./TakeoverStrip";

export type Provenance = "reported" | "dispatched" | "unknown";
type AutonomyJson = {
  resolved?: { harness?: string; baton?: string; commit?: boolean; push?: boolean; deploy?: boolean };
  overridden?: string[];
};
type LongRunState = {
  known: boolean;
  on: boolean;
  busy: boolean;
  error: string | null;
  label: string;
};

import { brandFor } from "../../shared/Avatar";
import { modelLabel } from "./modelLabel";

const MODELS = [
  { value: "opus", label: "opus" },
  { value: "sonnet", label: "sonnet" },
  { value: "fable", label: "fable" },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// The window filling up (#5508), living next to the dials that spend it (#5521). Colour comes
// from the tokens that exist — tr-fail is the red, tr-warn the amber — and the fill width is
// capped at 100 so an overflowed window shows a full red bar rather than a bar wider than its
// track.
const GAUGE_COLOUR = {
  neutral: "var(--color-tr-muted)",
  amber: "var(--color-tr-warn)",
  red: "var(--color-tr-fail)",
};

// The gauge joined the composer (#5521) so the window it describes sits beside the model and
// effort that fill it. Wider than the old header sliver, with the percentage spelled out and
// tinted by tone — the tone must be unmistakable at a glance, which a 14px sliver never was.
function ContextGauge({ ctx }: { ctx: ContextGauge }) {
  const tone = gaugeTone(ctx.frac);
  // Tokens without a window (#5503): say so instead of hiding — an absent gauge reads as
  // "fine" while the auto-handoff is in fact disarmed for exactly the same reason.
  if (tone === "hidden" && gaugeUnknownWindow(ctx)) {
    return (
      <div
        className="flex shrink-0 items-center gap-1.5"
        title={`${Math.round((ctx.tokens ?? 0) / 1000)}k used · context window unknown for this model — auto-handoff is disarmed (set contextWindow)`}
      >
        <span className="text-[10.5px] text-tr-muted">context</span>
        <span className="tr-mono text-[10.5px] text-tr-muted">?</span>
      </div>
    );
  }
  if (tone === "hidden") return null;
  // The guard above is what proves frac is known; the ?? 0 only satisfies the type at a point
  // the early return has already made unreachable.
  const frac = ctx.frac ?? 0;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5" title={gaugeLabel(ctx)}>
      {/* The bar says what it measures (#5556): a bare percentage next to two dials could be
          anything, so the word rides with it and the tooltip keeps the exact tokens. The bar is
          the ONE flexible part of the row (#5841, 440px pane): every dial is nowrap, and the
          bar takes whatever width is left instead of the model name wrapping onto two lines. */}
      <span className="shrink-0 text-[10.5px] text-tr-muted">context</span>
      <div className="h-1.5 min-w-[24px] max-w-20 flex-1 overflow-hidden rounded-full bg-tr-edge">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, frac * 100)}%`, background: GAUGE_COLOUR[tone] }} />
      </div>
      <span className="tr-mono w-[30px] shrink-0 text-right text-[10.5px]" style={{ color: GAUGE_COLOUR[tone] }}>
        {Math.round(frac * 100)}%
      </span>
    </div>
  );
}

/** The brand mark for the model dial — the same vendored SVG the avatars and the balance strip
 *  use, at dial size. Null for a model no brand claims (the id shows as it came). */
function modelMark(model: string): ReactNode {
  const { brand } = modelLabel(model);
  const b = brand ? brandFor(brand) : null;
  if (!b) return null;
  return (
    <span
      aria-hidden
      className="inline-block h-[13px] w-[13px] shrink-0 [&>svg]:h-full [&>svg]:w-full"
      style={{ color: b.hex }}
      dangerouslySetInnerHTML={{ __html: b.svg }}
    />
  );
}

function Picker({ label, value, source, options, onPick, disabled, why, icon, display, detail }: {
  label: string;
  value: string;
  source: Provenance;
  options: Array<{ value: string; label: string }>;
  onPick: (v: string) => void;
  disabled: boolean;
  /** Why the control is locked, shown while disabled — a dead-looking control that explains
   *  itself is a control people trust (#5477). */
  why: string;
  /** A mark and a shorter face for the value (the model dial: Claude mark + "5.1"); the full
   *  value stays in the tooltip. */
  icon?: ReactNode;
  display?: string;
  detail?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={
          disabled ? why
            : source === "dispatched" ? `Sent to the agent — not confirmed${detail ? ` · ${detail}` : ""}`
            : source === "reported" ? `${detail ?? label} reported by the session`
            : `${label} unknown until the session says`
        }
        className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[7px] px-2 py-1 text-[11px] text-tr-muted hover:text-tr-text disabled:opacity-40"
      >
        {icon}
        <span className={source === "dispatched" ? "italic" : undefined}>{display ?? (value || label)}</span>
        {source === "dispatched" && <span className="text-tr-warn">·</span>}
        <ChevronDown size={10} strokeWidth={2.5} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 min-w-[130px] overflow-hidden rounded-lg border border-tr-edge bg-tr-panel shadow-lg">
          {options.map(o => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onPick(o.value); setOpen(false); }}
              className="block w-full px-3 py-1.5 text-left text-[12px] text-tr-muted hover:bg-white/[0.05] hover:text-tr-text"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Reading size (#5522 → #5556): the three-step segmented control became a compact "Aa" trigger
 *  with a menu — a row of S/M/L beside two other rows of small controls read as noise, and the
 *  menu spells the choices out in words. The values and the prefs key are unchanged; only how
 *  they are offered moved. */
function FontMenu({ step, onPick }: { step: FontStep; onPick: (s: FontStep) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Chat text size"
        className="flex items-center gap-1 rounded-[7px] px-2 py-1 text-[12px] font-medium text-tr-muted hover:text-tr-text"
      >
        Aa
        <ChevronDown size={10} strokeWidth={2.5} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-10 mb-1 min-w-[110px] overflow-hidden rounded-lg border border-tr-edge bg-tr-panel shadow-lg">
          {FONT_STEPS.map(({ step: s, label }) => (
            <button
              key={s}
              type="button"
              onClick={() => { onPick(s); setOpen(false); }}
              data-on={s === step}
              className="block w-full px-3 py-1.5 text-left text-[12px] text-tr-muted hover:bg-white/[0.05] hover:text-tr-text data-[on=true]:font-medium data-[on=true]:text-tr-text"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- attachments (#6070)

/** An image chip's thumbnail: a `data:` URI read off the disk (attachment_info) and cached the way
 *  ProjectIcon caches project marks — module-level, so a re-render never re-reads the file.
 *  `undefined` = not asked yet (the glyph is the loading face); `null` = asked, and the disk said
 *  no (too big, no decoder, gone) — the glyph is the FINAL face. */
const THUMB_CACHE = new Map<string, string | null>();
const THUMB_INFLIGHT = new Map<string, Promise<string | null>>();

function loadThumb(path: string): Promise<string | null> {
  const hit = THUMB_CACHE.get(path);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = THUMB_INFLIGHT.get(path);
  if (running) return running;
  const p = attachmentInfo(path)
    .then(info => { const v = info?.thumb ?? null; THUMB_CACHE.set(path, v); THUMB_INFLIGHT.delete(path); return v; })
    .catch(() => { THUMB_CACHE.set(path, null); THUMB_INFLIGHT.delete(path); return null; });
  THUMB_INFLIGHT.set(path, p);
  return p;
}

function ChipThumb({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null | undefined>(() => THUMB_CACHE.get(path));
  useEffect(() => {
    const hit = THUMB_CACHE.get(path);
    if (hit !== undefined) { setSrc(hit); return; }
    let alive = true;
    void loadThumb(path).then(v => { if (alive) setSrc(v); });
    return () => { alive = false; };
  }, [path]);
  if (!src) {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-tr-muted">
        <ImageIcon size={13} strokeWidth={1.75} />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      // A thumb the webview cannot paint (an image that vanished since the drop) falls back to the
      // glyph rather than leaving a torn-image mark on the chip.
      onError={() => { THUMB_CACHE.set(path, null); setSrc(null); }}
      className="h-6 w-6 shrink-0 rounded-[5px] object-cover"
    />
  );
}

/** The chip row (#6070, bounced): one horizontal ROW below the text area — an image wears its
 *  thumbnail, anything else a file glyph, the size as a small caption, the × only on hover, and
 *  NO file name. Several attachments sit inline and never stack vertically, so the composer does
 *  not grow with them; the row scrolls sideways when it overflows. The full path stays in the
 *  tooltip. */
function AttachmentChips({ chips, onRemove }: { chips: AttachmentChip[]; onRemove: (id: string) => void }) {
  if (!chips.length) return null;
  return (
    <div className="mt-1.5 flex flex-nowrap items-center gap-1.5 overflow-x-auto">
      {chips.map(c => (
        <div
          key={c.id}
          title={c.path}
          className="group flex shrink-0 items-center gap-1 rounded-[8px] border border-tr-edge bg-tr-panel p-1"
        >
          {c.kind === "image"
            ? <ChipThumb path={c.path} />
            : (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center text-tr-muted">
                <FileText size={13} strokeWidth={1.75} />
              </span>
            )}
          {/* The size is the caption — the name never sits in the row (the bounce's one-line
              rule); the tooltip above carries the path for anyone who needs the words. */}
          {c.size !== null && <span className="tr-mono shrink-0 text-[10px] leading-none text-tr-muted">{formatBytes(c.size)}</span>}
          <button
            type="button"
            onClick={() => onRemove(c.id)}
            title={`remove ${c.name}`}
            className="shrink-0 rounded p-0.5 text-tr-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-tr-text focus-visible:opacity-100"
          >
            <X size={11} strokeWidth={2.5} />
          </button>
        </div>
      ))}
    </div>
  );
}

// #6147: the webview's drop event is WINDOW-global — the composer and the genesis sheet both
// hear every drop, so a PRD dropped on the sheet's brief also became an attachment chip in the
// chat behind it. A drop is the composer's only when the topmost element at the drop point is
// inside the composer, and never while a modal sheet is open: while the sheet is up its root
// carries data-modal-sheet-open and it owns every drop, wherever it lands.
export function composerTakesDrop(hit: Element | null, root: Element | null): boolean {
  if (!hit || !root) return false;
  if (document.querySelector("[data-modal-sheet-open]")) return false;
  return root.contains(hit);
}

export function Composer({ project, target, live, liveWhy, blockedAsk, model, modelSource, working, userTexts, context, fontStep, onFontStep, onSent, onLongRunChange, onDispatch, onDraftChange, suggestion, onSuggestionHandled }: {
  project: string;
  target: string | null;
  /** Is there an agent behind the pane to talk to (#5477)? Drives every input, with `liveWhy`
   *  naming the reason when there is not — a pane row that exists while its agent exited is the
   *  dead surface this exists to catch. */
  live: boolean;
  liveWhy: string;
  /** #6094 — non-null while the pane is blocked on an AskUserQuestion the transcript can name.
   *  `pane_send`'s own error ("answer it there (Terminal tray)") predates the question card and
   *  points at the wrong place now that the card sits right above the composer — a send attempted
   *  while this is set reports the specific ask instead. */
  blockedAsk?: OpenQuestion | null;
  model: string;
  modelSource: Provenance;
  working: boolean;
  /** The transcript's user turns, for delivery receipts (#5504): a send is only DELIVERED once
   *  one of these contains it — the transcript is the sole truth about arrival. */
  userTexts: string[];
  /** The context window as the transcript reports it (#5508) — the gauge beside the dials. */
  context: ContextGauge;
  /** The reading size (#5522): owned by the panel (the var applies to its root), dialled here. */
  fontStep: FontStep;
  onFontStep: (s: FontStep) => void;
  onSent: () => void;
  onLongRunChange: (on: boolean) => void;
  onDispatch: (dial: "model" | "effort", value: string) => void;
  /** Typing report for the suggested-reply chips (#5929): the row hides the moment the operator
   *  starts typing their own words. */
  onDraftChange?: (text: string) => void;
  /** A chip click arrives here and rides the EXISTING send path (receipts intact — it is a
   *  normal user turn); the panel clears it via onSuggestionHandled. */
  suggestion?: string | null;
  onSuggestionHandled?: () => void;
}) {
  const [draft, setDraft] = useState("");
  // Attachments live as CHIPS below the text (#6070): the text area holds only words the operator
  // typed — a path inside the text is exactly what dictation splits apart (#5773).
  const [chips, setChips] = useState<AttachmentChip[]>([]);
  const chipSeq = useRef(0);
  /** The one door all three attaches walk through (#6070): drop, paste, picker. The size rides in
   *  when the caller already holds it (a paste has its File); otherwise the disk answers later and
   *  the chip shows its name alone until then. */
  const attach = useCallback((paths: string[], size: number | null) => {
    if (!paths.length) return;
    const made = paths.map(p => makeChip(`chip-${chipSeq.current += 1}`, p, size));
    setChips(cs => addChips(cs, made));
    if (size !== null) return;
    for (const p of paths) {
      void attachmentInfo(p).then(info => {
        if (!info) return;
        setChips(cs => cs.map(c => (c.path === p && c.size === null ? { ...c, size: info.bytes } : c)));
      });
    }
  }, []);
  const [effort, setEffortValue] = useState("");
  const [effortSource, setEffortSource] = useState<Provenance>("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [longRun, setLongRun] = useState<LongRunState>({
    known: false,
    on: false,
    busy: false,
    error: null,
    label: "checking autonomy",
  });
  // @-reference. This is how you point the session at a PRD without typing a path from memory,
  // which is the same failure mode as typing a model id from memory.
  const [menu, setMenu] = useState<string[]>([]);
  const [pick, setPick] = useState(0);
  const box = useRef<HTMLTextAreaElement | null>(null);

  // Freely resizable (#6070): two lines to about 60% of the pane. Content grows the box until the
  // operator drags; a drag sets a height the box holds (taller content scrolls inside), and the
  // choice survives restart. The pane's height rides a ResizeObserver on the parent — the panel
  // root owns the vertical space the composer shares with the transcript.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panePx, setPanePx] = useState(700);
  useEffect(() => {
    const el = rootRef.current?.parentElement ?? null;
    // happy-dom (and old webviews) lack ResizeObserver; the membership probe is the pattern
    // ModePane uses for the same absence — a runtime typeof narrows a representation, not a
    // contract (the same probe paid its way into ModePane at #6044).
    if (!el || !("ResizeObserver" in globalThis)) return;
    const ro = new ResizeObserver(() => setPanePx(el.clientHeight));
    ro.observe(el);
    setPanePx(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const minPx = minComposerPx();
  const maxPx = maxComposerPx(panePx);
  // The remembered height loads ONCE the pane is measured: the ceiling on read is the pane's own,
  // so a stored height is clamped against the real bounds, not a guess.
  const heightLoaded = useRef(false);
  const [chosenPx, setChosenPx] = useState<number | null>(null);
  useEffect(() => {
    if (heightLoaded.current) return;
    heightLoaded.current = true;
    setChosenPx(loadComposerHeight(minPx, maxPx));
  }, [minPx, maxPx]);
  // The content's own height, measured whenever the draft changes: collapse to auto and read the
  // scroll height. The measured value is RESTORED afterwards, not blanked — React wrote that style
  // at commit and does not rewrite an unchanged prop, so a blank would strand the textarea with
  // whatever default the webview falls back to (that blank is what made the first build's box
  // forget its height). A layout effect, so it never paints between the two writes.
  const [contentPx, setContentPx] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const prev = el.style.height;
    el.style.height = "auto";
    const h = el.scrollHeight;
    el.style.height = prev;
    setContentPx(h);
  }, [draft]);
  const grown = growComposerPx(contentPx ?? minPx, minPx, maxPx);
  const heightPx = chosenPx === null ? grown : Math.min(chosenPx, maxPx);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  // The drag rides WINDOW listeners, not the handle's own pointermove (#6070 bounce: the built
  // app's handle was inert). Pointer capture does not reliably retarget moves back to the
  // capturing element under WKWebView, so the moves never arrived there; window carries the drag
  // wherever the pointer goes. Capture stays as an enhancement that cannot kill the drag when a
  // window refuses it.
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => { dragCleanup.current?.(); }, []);
  const handleDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no capture here — the window listeners carry the drag anyway */ }
    dragRef.current = { startY: e.clientY, startH: heightPx };
    // The handle sits on the field's TOP edge over a bottom-anchored box, so dragging UP grows it:
    // the height gains what clientY LOSES (the first bounce shipped this sign inverted — the code
    // review of 9961b74 caught it, the box shrinking into its floor on every upward drag).
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setChosenPx(clampComposerPx(d.startH - (ev.clientY - d.startY), minPx, maxPx));
    };
    const drop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      dragCleanup.current = null;
    };
    const up = (ev: PointerEvent) => {
      drop();
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      const next = clampComposerPx(d.startH - (ev.clientY - d.startY), minPx, maxPx);
      setChosenPx(next);
      saveComposerHeight(next, minPx, maxPx);
    };
    const cancel = () => { drop(); dragRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    // An unmount mid-drag must not strand window listeners behind a dead component.
    dragCleanup.current = () => { drop(); dragRef.current = null; };
  };

  // The locked composer's one action (#5495), derived from the session inventory and polled
  // ONLY while locked — the contract's gentle cadence, not a second heartbeat. A mid-turn
  // Terminal conversation auto-enables the moment its turn ends; a live pane stops the poll
  // entirely. A failed read keeps the last good inventory (transient), and none read yet means
  // no offer: an unread state never wears a button.
  const [inventory, setInventory] = useState<ProjectSessions | null>(null);
  useEffect(() => {
    if (live) return;
    let alive = true;
    const look = () => projectSessions(project).then(s => { if (alive) setInventory(s); }).catch(() => {});
    look();
    const iv = setInterval(look, 5_000);
    return () => { alive = false; clearInterval(iv); };
  }, [project, live]);
  const action = live ? null : takeoverAction(inventory);

  // Full auto (operator's ruling, #5644 round 2): ON means the build runs WITHOUT human input —
  // permission prompts bypassed AND the 90% handoff fires itself. Both dials or it isn't full
  // auto; a mixed state reads as off and the tooltip names the mix instead of pretending.
  const autonomyState = (raw: string, busyState = false): LongRunState => {
    const data: AutonomyJson = JSON.parse(raw);
    const resolved = data.resolved ?? {};
    const harness = resolved.harness ?? "unknown";
    const baton = resolved.baton ?? "unknown";
    const on = harness === "bypass" && baton === "auto";
    const mixed = !on && (harness === "bypass" || baton === "auto");
    return {
      known: true,
      on,
      busy: busyState,
      error: null,
      label: on
        ? "on — the build runs without asking: prompts bypassed, the 90% handoff fires itself"
        : mixed
          ? `partly on (harness ${harness}, handoff ${baton}) — toggle to set both`
          : "off — the harness asks, and the handoff banner counts down",
    };
  };

  useEffect(() => {
    let alive = true;
    setLongRun(s => ({ ...s, known: false, busy: true, error: null, label: "checking autonomy" }));
    invoke<string>("autonomy_get", { project })
      .then(raw => { if (alive) setLongRun(autonomyState(raw)); })
      .catch(e => { if (alive) setLongRun({ known: false, on: false, busy: false, error: String(e), label: "autonomy unavailable" }); });
    return () => { alive = false; };
  }, [project]);

  useEffect(() => {
    onLongRunChange(longRun.known && longRun.on);
  }, [longRun.known, longRun.on, onLongRunChange]);

  const toggleLongRun = () => {
    const next = !longRun.on;
    setLongRun(s => ({ ...s, busy: true, error: null, label: next ? "switching to full auto" : "switching back to ask" }));
    // Both dials, harness then baton — full auto is one idea, set atomically enough that a
    // failure between the two still lands on an honest "partly on" read from the second fetch.
    invoke<string>("autonomy_set", { project, dial: "harness", value: next ? "bypass" : "prompt" })
      .then(() => invoke<string>("autonomy_set", { project, dial: "baton", value: next ? "auto" : "ask" }))
      .then(raw => setLongRun(autonomyState(raw)))
      .catch(e => setLongRun(s => ({ ...s, busy: false, error: String(e), label: "autonomy change failed" })));
  };

  /** The @token being typed, or null. Anchored to the LAST @ so a message can mention several. */
  const token = (() => {
    const upto = draft.slice(0, box.current?.selectionStart ?? draft.length);
    const at = upto.lastIndexOf("@");
    if (at < 0) return null;
    const frag = upto.slice(at + 1);
    // A space ends it: "@ " is someone typing an email or a sentence, not a path.
    return /\s/.test(frag) ? null : frag;
  })();

  useEffect(() => {
    if (token === null) { setMenu([]); return; }
    let alive = true;
    searchFiles(project, token).then(r => { if (alive) { setMenu(r); setPick(0); } }).catch(() => {});
    return () => { alive = false; };
  }, [token, project]);

  const accept = (path: string) => {
    const cur = box.current?.selectionStart ?? draft.length;
    const upto = draft.slice(0, cur);
    const at = upto.lastIndexOf("@");
    // A picked file becomes a CHIP (#6070): the @-fragment leaves the draft, the path rides below
    // the text — never a splice dictation could split apart. Whatever surrounded the @ stays.
    setDraft(draft.slice(0, at) + draft.slice(cur));
    setMenu([]);
    attach([path], null);
  };

  // File drop (#5507). Tauri's webview intercepts native HTML5 drops by default, so
  // onDragDropEvent is the only channel an ondrop handler would never fire on. A drop lands each
  // file as a CHIP below the text (#6070) — the path never enters the text area, so dictation
  // cannot split it — and at SEND the chips serialize to exactly the bytes the old drop splice
  // shipped, receipts and normalization untouched.
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    try {
      getCurrentWebview().onDragDropEvent(ev => {
        if (ev.payload.type !== "drop") return;
        const paths = ev.payload.paths;
        if (!paths.length) return;
        // #6147: the drop point resolves to the TOPMOST element (physical px → CSS px, the same
        // resolution the genesis sheet uses for its own zone) — a drop that landed on a sheet,
        // the file tree or the terminal is theirs, never an attachment chip here.
        const dpr = window.devicePixelRatio || 1;
        const hit = document.elementFromPoint(ev.payload.position.x / dpr, ev.payload.position.y / dpr);
        if (!composerTakesDrop(hit, rootRef.current)) return;
        attach(paths, null);
      }).then(un => { if (alive) off = un; else un(); })
        .catch(() => { /* no webview under this window (tests) — drops are a no-op there */ });
    } catch {
      // getCurrentWebview throws outside a Tauri window; the composer still works, just undroppable.
    }
    return () => { alive = false; off?.(); };
  }, [attach]);

  // #6250: `to` defaults to the selection, but a RESEND must name the pending's own pane — the
  // pending, not the selection, owns where its words go. Slash commands and fresh sends have no
  // pending and take the default.
  const line = (text: string, to: string | null = target) =>
    invoke("pane_send", { target: to, text }).catch(e => setError(
      // #6094 — pane_send's own "answer it there (Terminal tray)" predates the question card and
      // now points at the wrong place: the ask is rendered right above this composer.
      blockedAsk ? `The agent is asking a question above — answer it there: "${blockedAsk.questions[0]?.question ?? ""}"` : String(e),
    ));

  // Paste-an-image (2026-09-01: the operator pasted a CleanShot screenshot twice and NOTHING
  // happened — a textarea silently swallows image DATA, so "upload" looked broken with no error).
  // The clipboard image is written to a real file (Rust, ~/.agent-bus/attachments/) and lands as
  // a CHIP (#6070) — the same one attach mechanism the drop uses. Plain text pastes are
  // untouched. Failures surface in the composer's error line, never silently.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const img = Array.from(e.clipboardData?.items ?? []).find(
      i => i.kind === "file" && i.type.startsWith("image/"),
    );
    const file = img?.getAsFile();
    if (!file) return;
    e.preventDefault();
    void file.arrayBuffer().then(buf => {
      // chunked, because String.fromCharCode(...multi-MB-array) blows the argument limit
      const u8 = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return invoke<string>("save_pasted_image", { dataBase64: btoa(bin), kind: file.type }).then(path => {
        // The clipboard File is already stat'ed — its size rides in with no disk round-trip.
        attach([path], file.size);
        setError(null);
        box.current?.focus();
      });
    }).catch(err => setError(`pasted image failed: ${err instanceof Error ? err.message : String(err)}`));
  };

  // Delivery receipts (#5504). Typed-into-a-terminal is not a delivery channel: the CLI's UI can
  // eat or fuse what arrives, so every send is held as PENDING until the transcript echoes it
  // back. While anything is pending, poll the transcript and re-judge; a send the transcript
  // never echoes is declared LOST, visibly, with its words intact for retry — never silently.
  //
  // A pending is judged ONLY against its own project's transcript (#6250): this morning a send
  // to trantor was judged against hive-digital's transcript the moment the operator switched,
  // read as lost, and mechanically retried into hive-digital's pane. So a pending whose project
  // is not the selection is neither judged, retried, nor shown — it just waits, holding the
  // address it was sent to, until its own project is back.
  const [pendings, setPendings] = useState<PendingSend[]>([]);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!pendings.some(p => p.project === project)) return;
    const t = setInterval(() => { onSent(); setTick(n => n + 1); }, 2000);
    return () => clearInterval(t);
  }, [pendings, project, onSent]);
  useEffect(() => {
    setPendings(ps => {
      const kept = ps.filter(p => p.project !== project || receiptFor(p, userTexts, Date.now()) !== "delivered");
      return kept.length === ps.length ? ps : kept;
    });
  }, [userTexts, project]);
  const ownPendings = pendings.filter(p => p.project === project);
  const lost = ownPendings.filter(p => receiptFor(p, userTexts, Date.now()) === "lost");
  const inFlight = ownPendings.length - lost.length;

  const sendText = (raw: string): boolean => {
    // Multi-image sends are rewritten to one-path-per-line BEFORE delivery (#5709) — CC's
    // converter drops an image when several paths ride one message inline. The pending holds
    // the NORMALIZED text: receipts must judge what was actually typed into the pane.
    const text = normalizeAttachments(raw.trim());
    if (!text || !target) return false;
    setBusy(true);
    line(text).then(() => {
      setPendings(ps => [...ps, { text, at: Date.now(), project, target }]);
      setError(null); onSent();
    }).finally(() => setBusy(false));
    return true;
  };

  const send = () => {
    // Chips serialize AT SEND (#6070): the paths join the words in exactly the shape the delivery
    // path knows (sendText then normalizes exactly as it always has), and both clear together on
    // success. A suggested-reply click rides sendText WITHOUT the chips — it is its own turn.
    if (sendText(serializeForSend(chips, draft))) { setDraft(""); setChips([]); }
  };

  // A suggested reply IS a send (#5929): it rides sendText — the same delivery, the same
  // receipt — and the panel clears the suggestion so it cannot fire twice.
  useEffect(() => {
    if (!suggestion) return;
    if (sendText(suggestion)) onSuggestionHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion]);

  const retry = (p: PendingSend) => {
    setPendings(ps => ps.filter(x => x !== p));
    line(p.text, p.target).then(() => setPendings(ps => [...ps, { text: p.text, at: Date.now(), project: p.project, target: p.target }]));
  };

  // ONE mechanical retry at the turn boundary (2026-08-31: an attachment sent MID-TURN was eaten
  // by the streaming TUI and sat "lost" until a human clicked retry — the exact failure the
  // receipt exists to catch, now answered by the machine once). A send lost AGAIN after its
  // retry stays red for the human; retrying forever would spam a genuinely broken pane.
  // Only THIS project's pendings are in evidence here (#6250): the transcript and the turn
  // boundary are the selection's, so a foreign pending is neither judged lost by them nor
  // re-sent into the selected pane — the trace that put trantor's words in hive-digital.
  useEffect(() => {
    if (working) return;
    setPendings(ps => {
      const now = Date.now();
      // Never auto-retry a send carrying image paths: a duplicated screenshot message is worse
      // than a lost one, and attachment sends are exactly the receipt's false-alarm class
      // (gap six). Those keep the manual retry button only.
      const toRetry = ps.filter(p => p.project === project && !p.retried && !hasImagePath(p.text) && receiptFor(p, userTexts, now) === "lost");
      if (!toRetry.length) return ps;
      for (const p of toRetry) void line(p.text, p.target);
      return ps.map(p => (toRetry.includes(p) ? { text: p.text, at: now, project: p.project, target: p.target, retried: true } : p));
    });
  }, [working]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Interrupting is a KEY, not a message. Escape is what stops a turn in the harness.
  const stop = () => { if (target) invoke("pane_keys", { target, keys: "Escape" }).catch(e => setError(String(e))); };

  // What the field's one slot shows (#5556): the pure rule lives in streaming.ts so it is
  // drilled there; this is just its wiring. Chips count as payload too — an attachments-only send
  // is a real send — so a " " stands in for the chips this component owns while the rule stays
  // pure on the draft.
  const slot = composerSlot(working, live, chips.length && !draft.trim() ? " " : draft, busy);

  // A slash command is typed exactly as a person would type it, then marked dispatched until the
  // transcript reports the new value back.
  const pickModel = (v: string) => { line(`/model ${v}`); onDispatch("model", v); };
  const pickEffort = (v: string) => {
    line(`/effort ${v}`);
    // Effort is not echoed anywhere we read, so the honest state is "dispatched" and it stays that
    // way. Showing it as applied would be the assertion this whole design refuses to make.
    setEffortValue(v);
    setEffortSource("dispatched");
    onDispatch("effort", v);
  };

  return (
    <div ref={rootRef} className="border-t border-tr-edge p-2">
      {menu.length > 0 && (
        <div className="mb-1 max-h-[190px] overflow-y-auto rounded-lg border border-tr-edge bg-tr-panel">
          {menu.map((f, i) => (
            <button
              key={f}
              type="button"
              onMouseEnter={() => setPick(i)}
              onClick={() => accept(f)}
              data-on={i === pick}
              className="tr-mono block w-full truncate px-2.5 py-1 text-left text-[11.5px] text-tr-muted data-[on=true]:bg-white/[0.06] data-[on=true]:text-tr-text"
            >
              {f}
            </button>
          ))}
        </div>
      )}
      {lost.map((p, i) => (
        <div key={`${p.at}-${i}`} className="mb-1 flex items-center gap-2 rounded-lg border border-tr-fail/40 bg-tr-fail/10 px-2.5 py-1.5 text-[11.5px]">
          <span className="min-w-0 flex-1 truncate text-tr-fail">
            not delivered — the session never received: “{p.text}”
          </span>
          <button type="button" onClick={() => retry(p)} className="shrink-0 text-tr-text hover:underline">retry</button>
          <button type="button" onClick={() => setPendings(ps => ps.filter(x => x !== p))} className="shrink-0 text-tr-muted hover:underline">dismiss</button>
        </div>
      ))}
      {inFlight > 0 && (
        <div className="tr-mono mb-1 px-1 text-[10.5px] text-tr-muted">delivering…</div>
      )}
      {/* The locked state's one action (#5495): the biggest control explains itself by naming
          what it would take to unlock — start, continue, reopen — instead of sitting grey. */}
      {!live && action && (
        <div className="mb-1">
          <TakeoverStrip project={project} action={action} />
        </div>
      )}
      {/* The field (#5556): the container is the input box now, and the action slot lives
          bottom-right INSIDE it — one position, two states, the Claude-desktop pattern. The
          textarea keeps its padding on every side except the right, which widens so words never
          run under the button. The drag handle along its top edge resizes it (#6070): two lines
          to about 60% of the pane, and the height is remembered.

          ONE visible border (#6070 bounce): the container's own. The textarea carries none — no
          rounding of its own, and its focus outline explicitly off, because the global
          `textarea:focus-visible` rule in styles.css outranks a bare `outline-none` class and
          used to draw a stray inner frame every time the operator clicked in to type. */}
      <div className="relative overflow-hidden rounded-lg border border-tr-edge bg-black/30">
        <div
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize — the height is remembered"
          onPointerDown={handleDragStart}
          className="flex h-2.5 w-full cursor-row-resize touch-none items-center justify-center"
        >
          <span className="h-[3px] w-9 rounded-full bg-tr-edge" />
        </div>
        <textarea
          ref={box}
          value={draft}
          onChange={e => { setDraft(e.target.value); onDraftChange?.(e.target.value); }}
          onPaste={onPaste}
          onKeyDown={e => {
            // While the menu is up it owns the arrows and Enter, the way every editor does it.
            if (menu.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setPick(p => (p + 1) % menu.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setPick(p => (p - 1 + menu.length) % menu.length); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); accept(menu[pick]); return; }
              if (e.key === "Escape") { e.preventDefault(); setMenu([]); return; }
            }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder={live ? "Message the orchestrator…  (⇧⏎ for a new line)" : liveWhy}
          disabled={!live || busy}
          style={{ height: `${heightPx}px` }}
          className="w-full resize-none overflow-y-auto bg-transparent p-2.5 pr-12 text-[12.5px] leading-relaxed outline-none focus-visible:outline-none focus:outline-none placeholder:text-tr-muted disabled:opacity-50"
        />
        {slot.kind === "stop" ? (
          <button
            type="button"
            onClick={stop}
            title="interrupt this turn"
            className="absolute bottom-1.5 right-1.5 flex items-center justify-center rounded-[8px] bg-tr-panel px-2.5 py-1.5 text-tr-text"
          >
            <Square size={11} strokeWidth={2.5} />
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={slot.disabled}
            title={!live ? liveWhy : "Send"}
            className="absolute bottom-1.5 right-1.5 flex items-center justify-center rounded-[8px] bg-tr-ok px-2.5 py-1.5 text-[#07130f] disabled:opacity-40"
          >
            <ArrowUp size={12} strokeWidth={2.5} />
          </button>
        )}
      </div>
      {/* Attachments wear chips BELOW the text area (#6070): faces, not paths. */}
      <AttachmentChips chips={chips} onRemove={id => setChips(cs => removeChip(cs, id))} />
      <div className="mt-1.5 flex items-center gap-1">
        {/* "Attach" for a local CLI agent is not an upload — the file is already on its disk. The
            honest action is to reference the path, which is also how you point it at a PRD. */}
        <button
          type="button"
          onClick={() => { setDraft(d => (d.endsWith(" ") || !d ? d : d + " ") + "@"); box.current?.focus(); }}
          disabled={!live}
          title={live ? "reference a file by path" : liveWhy}
          className="rounded-[7px] p-1.5 text-tr-muted hover:text-tr-text disabled:opacity-40"
        >
          <Paperclip size={13} strokeWidth={1.75} />
        </button>
        <Picker
          label="model"
          value={model}
          source={modelSource}
          options={MODELS}
          onPick={pickModel}
          disabled={!live}
          why={liveWhy}
          icon={modelMark(model)}
          display={model ? modelLabel(model).short : undefined}
          detail={model ? modelLabel(model).full : undefined}
        />
        <Picker
          label="effort"
          value={effort}
          source={effortSource}
          options={EFFORTS.map(e => ({ value: e, label: e }))}
          onPick={pickEffort}
          disabled={!live}
          why={liveWhy}
        />
        <button
          type="button"
          role="switch"
          aria-checked={longRun.known && longRun.on}
          onClick={toggleLongRun}
          disabled={longRun.busy}
          title={longRun.error ?? `Full auto — ${longRun.label}`}
          className="flex shrink-0 items-center gap-1 rounded-[7px] px-2 py-1 text-[11px] text-tr-muted hover:text-tr-text disabled:opacity-40"
        >
          {/* ON wears warn amber on purpose: this is the switch that makes the machine stop
              asking. The dial-speak caption is gone from the bar — it mangled the row and read
              as noise (operator, round 2); the full explanation lives in the tooltip. */}
          <span className={`h-3 w-5 rounded-full border ${longRun.known && longRun.on ? "border-tr-warn bg-tr-warn/20" : "border-tr-edge bg-black/20"}`}>
            <span className={`block h-2.5 w-2.5 rounded-full ${longRun.known && longRun.on ? "translate-x-2 bg-tr-warn" : "bg-tr-muted"}`} />
          </span>
          <span className={longRun.known && longRun.on ? "text-tr-warn" : ""}>full auto</span>
        </button>
        {/* The gauge sits beside the dials that fill the window (#5521) — the number is mono
            because it is a number being compared, and it is hidden until truth exists. */}
        <ContextGauge ctx={context} />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <FontMenu step={fontStep} onPick={onFontStep} />
        </div>
      </div>
      {error && <div className="tr-mono mt-1 text-[11px] text-tr-fail">{error}</div>}
    </div>
  );
}
