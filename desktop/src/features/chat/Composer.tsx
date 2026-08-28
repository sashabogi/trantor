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
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ChevronDown, Paperclip, Square, ArrowUp } from "lucide-react";
import { searchFiles } from "../files/fileApi";
import { FONT_STEPS, type FontStep } from "./prefs";
import { gaugeLabel, gaugeTone, composerSlot, insertPaths, receiptFor, type ContextGauge, type PendingSend } from "./streaming";
import { projectSessions, takeoverAction, type ProjectSessions } from "./takeover";
import { TakeoverStrip } from "./TakeoverStrip";

export type Provenance = "reported" | "dispatched" | "unknown";

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
  if (tone === "hidden") return null;
  // The guard above is what proves frac is known; the ?? 0 only satisfies the type at a point
  // the early return has already made unreachable.
  const frac = ctx.frac ?? 0;
  return (
    <div className="flex shrink-0 items-center gap-1.5" title={gaugeLabel(ctx)}>
      {/* The bar says what it measures (#5556): a bare percentage next to two dials could be
          anything, so the word rides with it and the tooltip keeps the exact tokens. */}
      <span className="text-[10.5px] text-tr-muted">context</span>
      <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-tr-edge">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, frac * 100)}%`, background: GAUGE_COLOUR[tone] }} />
      </div>
      <span className="tr-mono w-[30px] text-right text-[10.5px]" style={{ color: GAUGE_COLOUR[tone] }}>
        {Math.round(frac * 100)}%
      </span>
    </div>
  );
}

function Picker({ label, value, source, options, onPick, disabled, why }: {
  label: string;
  value: string;
  source: Provenance;
  options: Array<{ value: string; label: string }>;
  onPick: (v: string) => void;
  disabled: boolean;
  /** Why the control is locked, shown while disabled — a dead-looking control that explains
   *  itself is a control people trust (#5477). */
  why: string;
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
            : source === "dispatched" ? `Sent to the agent — not confirmed`
            : source === "reported" ? `${label} reported by the session`
            : `${label} unknown until the session says`
        }
        className="flex items-center gap-1 rounded-[7px] px-2 py-1 text-[11px] text-tr-muted hover:text-tr-text disabled:opacity-40"
      >
        <span className={source === "dispatched" ? "italic" : undefined}>{value || label}</span>
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

export function Composer({ project, target, live, liveWhy, model, modelSource, working, userTexts, context, fontStep, onFontStep, onSent, onDispatch }: {
  project: string;
  target: string | null;
  /** Is there an agent behind the pane to talk to (#5477)? Drives every input, with `liveWhy`
   *  naming the reason when there is not — a pane row that exists while its agent exited is the
   *  dead surface this exists to catch. */
  live: boolean;
  liveWhy: string;
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
  onDispatch: (dial: "model" | "effort", value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [effort, setEffortValue] = useState("");
  const [effortSource, setEffortSource] = useState<Provenance>("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // @-reference. This is how you point the session at a PRD without typing a path from memory,
  // which is the same failure mode as typing a model id from memory.
  const [menu, setMenu] = useState<string[]>([]);
  const [pick, setPick] = useState(0);
  const box = useRef<HTMLTextAreaElement | null>(null);

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
    setDraft(draft.slice(0, at) + path + " " + draft.slice(cur));
    setMenu([]);
  };

  // File drop (#5507). Tauri's webview intercepts native HTML5 drops by default, so
  // onDragDropEvent is the only channel an ondrop handler would never fire on. A drop splices
  // each absolute path plus a trailing space into the draft at the caret — the same splice the
  // @-accept performs — and leaves the caret after the insertion.
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    try {
      getCurrentWebview().onDragDropEvent(ev => {
        if (ev.payload.type !== "drop") return;
        const paths = ev.payload.paths;
        if (!paths.length) return;
        const cur = box.current?.selectionStart ?? null;
        setDraft(d => insertPaths(d, cur ?? d.length, paths));
        if (cur !== null) {
          const after = cur + paths.reduce((n, p) => n + p.length + 1, 0);
          requestAnimationFrame(() => box.current?.setSelectionRange(after, after));
        }
      }).then(un => { if (alive) off = un; else un(); })
        .catch(() => { /* no webview under this window (tests) — drops are a no-op there */ });
    } catch {
      // getCurrentWebview throws outside a Tauri window; the composer still works, just undroppable.
    }
    return () => { alive = false; off?.(); };
  }, []);

  const line = (text: string) =>
    invoke("pane_send", { target, text }).catch(e => setError(String(e)));

  // Delivery receipts (#5504). Typed-into-a-terminal is not a delivery channel: the CLI's UI can
  // eat or fuse what arrives, so every send is held as PENDING until the transcript echoes it
  // back. While anything is pending, poll the transcript and re-judge; a send the transcript
  // never echoes is declared LOST, visibly, with its words intact for retry — never silently.
  const [pendings, setPendings] = useState<PendingSend[]>([]);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!pendings.length) return;
    const t = setInterval(() => { onSent(); setTick(n => n + 1); }, 2000);
    return () => clearInterval(t);
  }, [pendings.length, onSent]);
  useEffect(() => {
    setPendings(ps => {
      const kept = ps.filter(p => receiptFor(p, userTexts, Date.now()) !== "delivered");
      return kept.length === ps.length ? ps : kept;
    });
  }, [userTexts]);
  const lost = pendings.filter(p => receiptFor(p, userTexts, Date.now()) === "lost");
  const inFlight = pendings.length - lost.length;

  const send = () => {
    const text = draft.trim();
    if (!text || !target) return;
    setBusy(true);
    line(text).then(() => {
      setPendings(ps => [...ps, { text, at: Date.now() }]);
      setDraft(""); setError(null); onSent();
    }).finally(() => setBusy(false));
  };

  const retry = (p: PendingSend) => {
    setPendings(ps => ps.filter(x => x !== p));
    line(p.text).then(() => setPendings(ps => [...ps, { text: p.text, at: Date.now() }]));
  };

  // Interrupting is a KEY, not a message. Escape is what stops a turn in the harness.
  const stop = () => { if (target) invoke("pane_keys", { target, keys: "Escape" }).catch(e => setError(String(e))); };

  // What the field's one slot shows (#5556): the pure rule lives in streaming.ts so it is
  // drilled there; this is just its wiring.
  const slot = composerSlot(working, live, draft, busy);

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
    <div className="border-t border-tr-edge p-2">
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
          run under the button. */}
      <div className="relative rounded-lg bg-black/30">
        <textarea
          ref={box}
          value={draft}
          onChange={e => setDraft(e.target.value)}
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
          rows={2}
          className="w-full resize-none rounded-lg bg-transparent p-2.5 pr-12 text-[12.5px] leading-relaxed outline-none placeholder:text-tr-muted disabled:opacity-50"
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
        {/* The gauge sits beside the dials that fill the window (#5521) — the number is mono
            because it is a number being compared, and it is hidden until truth exists. */}
        <ContextGauge ctx={context} />
        <div className="ml-auto flex items-center gap-2">
          <FontMenu step={fontStep} onPick={onFontStep} />
        </div>
      </div>
      {error && <div className="tr-mono mt-1 text-[11px] text-tr-fail">{error}</div>}
    </div>
  );
}
