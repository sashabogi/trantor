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
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Paperclip, Square, ArrowUp } from "lucide-react";

export type Provenance = "reported" | "dispatched" | "unknown";

const MODELS = [
  { value: "opus", label: "opus" },
  { value: "sonnet", label: "sonnet" },
  { value: "fable", label: "fable" },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function Picker({ label, value, source, options, onPick, disabled }: {
  label: string;
  value: string;
  source: Provenance;
  options: Array<{ value: string; label: string }>;
  onPick: (v: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={
          source === "dispatched" ? `Sent to the agent — not confirmed`
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

export function Composer({ target, model, modelSource, working, onSent, onDispatch }: {
  target: string | null;
  model: string;
  modelSource: Provenance;
  working: boolean;
  onSent: () => void;
  onDispatch: (dial: "model" | "effort", value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [effort, setEffortValue] = useState("");
  const [effortSource, setEffortSource] = useState<Provenance>("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const line = (text: string) =>
    invoke("pane_send", { target, text }).catch(e => setError(String(e)));

  const send = () => {
    const text = draft.trim();
    if (!text || !target) return;
    setBusy(true);
    line(text).then(() => { setDraft(""); setError(null); onSent(); }).finally(() => setBusy(false));
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
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        placeholder={target ? "Message the orchestrator…  (⇧⏎ for a new line)" : "no session to talk to"}
        disabled={!target || busy}
        rows={2}
        className="w-full resize-none rounded-lg bg-black/30 p-2.5 text-[12.5px] leading-relaxed outline-none placeholder:text-tr-muted disabled:opacity-50"
      />
      <div className="mt-1.5 flex items-center gap-1">
        {/* "Attach" for a local CLI agent is not an upload — the file is already on its disk. The
            honest action is to reference the path, which is also how you point it at a PRD. */}
        <button
          type="button"
          onClick={() => setDraft(d => (d.endsWith(" ") || !d ? d : d + " ") + "@")}
          disabled={!target}
          title="reference a file by path"
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
          disabled={!target}
        />
        <Picker
          label="effort"
          value={effort}
          source={effortSource}
          options={EFFORTS.map(e => ({ value: e, label: e }))}
          onPick={pickEffort}
          disabled={!target}
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
              disabled={!target || !draft.trim() || busy}
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
