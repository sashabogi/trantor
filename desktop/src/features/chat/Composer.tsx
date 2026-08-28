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
import { insertPaths, receiptFor, type PendingSend } from "./streaming";

export type Provenance = "reported" | "dispatched" | "unknown";

const MODELS = [
  { value: "opus", label: "opus" },
  { value: "sonnet", label: "sonnet" },
  { value: "fable", label: "fable" },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

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

export function Composer({ project, target, live, liveWhy, model, modelSource, working, userTexts, onSent, onDispatch }: {
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
        const cur = box.current?.selectionStart;
        setDraft(d => insertPaths(d, cur ?? d.length, paths));
        if (typeof cur === "number") {
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
        <div key={`${p.at}-${i}`} className="mb-1 flex items-center gap-2 rounded-lg border border-tr-danger/40 bg-tr-danger/10 px-2.5 py-1.5 text-[11.5px]">
          <span className="min-w-0 flex-1 truncate text-tr-danger">
            not delivered — the session never received: “{p.text}”
          </span>
          <button type="button" onClick={() => retry(p)} className="shrink-0 text-tr-text hover:underline">retry</button>
          <button type="button" onClick={() => setPendings(ps => ps.filter(x => x !== p))} className="shrink-0 text-tr-muted hover:underline">dismiss</button>
        </div>
      ))}
      {inFlight > 0 && (
        <div className="tr-mono mb-1 px-1 text-[10.5px] text-tr-muted">delivering…</div>
      )}
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
        className="w-full resize-none rounded-lg bg-black/30 p-2.5 text-[12.5px] leading-relaxed outline-none placeholder:text-tr-muted disabled:opacity-50"
      />
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
        <div className="ml-auto flex items-center gap-1">
          {working ? (
            <button
              type="button"
              onClick={stop}
              title="interrupt this turn"
              className="flex items-center gap-1.5 rounded-[8px] bg-tr-panel px-2.5 py-1.5 text-[11.5px] font-medium"
            >
              <Square size={11} strokeWidth={2.5} /> stop
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!live || !draft.trim() || busy}
              title={!live ? liveWhy : undefined}
              className="flex items-center gap-1 rounded-[8px] bg-tr-ok px-2.5 py-1.5 text-[11.5px] font-semibold text-[#07130f] disabled:opacity-40"
            >
              <ArrowUp size={12} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
      {error && <div className="tr-mono mt-1 text-[11px] text-tr-danger">{error}</div>}
    </div>
  );
}
