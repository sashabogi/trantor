import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Paperclip, Square } from "lucide-react";
import { Avatar } from "./Avatar";
import { IconButton } from "./IconButton";
import { Ring } from "./Ring";
import { brandOfModel, modelHue, seatLabel } from "./identity";
import { AttachmentRow } from "./AttachmentRow";
import type { AttachmentsApi } from "./useAttachments";
import { ChipMenu, ChoiceIcon, ChoiceRow, LevelPills, MenuHeading, type Choice } from "./ComposerMenu";

export type { Choice } from "./ComposerMenu";

export type Composer2Props = {
  busy?: boolean;
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed text on Enter or the send button; the parent clears `value`. */
  onSend: (text: string) => void;
  /** Accessible name of the text box, e.g. "Message codex-8". */
  label: string;
  placeholder?: string;
  /** Who answers: a seat or session name ("orchestrator", "codex-8"). */
  agent: string;
  /** Model id ("claude-opus-5-5") and the name shown ("Opus 5.5"). */
  model: { id: string; label: string };
  /** The models this agent can switch to; omit and the model is a plain label. */
  modelChoices?: readonly Choice[];
  /** The choice the current model corresponds to, when known. */
  modelValue?: string | null;
  onModelChange?: (value: string) => void;
  /** Omit where the agent has no effort control; null = it has one but the level is not known. */
  effort?: string | null;
  effortChoices?: readonly Choice[];
  onEffortChange?: (value: string) => void;
  /** #14022: the hosted agent's live mode as read back; null = it has modes but the read failed. Omit with no modes. */
  mode?: string | null;
  /** Data-driven per harness: what this session's mode cycle offers. */
  modeChoices?: readonly Choice[];
  /** Settles when the switch has been read back or refused; the parent reports a refusal. */
  onModeChange?: (value: string) => Promise<void>;
  modeReading?: boolean;
  onModeMenuOpen?: () => void;
  /** Omit where there is no permission level to show. */
  permission?: string;
  permissionChoices?: readonly Choice[];
  onPermissionChange?: (value: string) => void;
  /** The permission section's heading, when the default "Permission level for X" would mislead (#14022). */
  permissionHeading?: string;
  /** Opens the settings page behind the permission menu's last row. */
  onPermissionSettings?: () => void;
  /** Context window used, 0 to 100; null hides the ring (not reported yet). */
  contextPct: number | null;
  onAttach?: () => void;
  /** #14487: interrupt the running turn — while set, the one action button is Stop and Esc in the
   *  box does the same. The parent decides when a turn is stoppable; omit when it never is. */
  onStop?: () => void;
  /** Chips, drop, paste and picker (#13984 drill); omit and the paperclip stays as `onAttach` says. */
  attachments?: AttachmentsApi;
  /** Disables sending and says why. */
  disabledReason?: string | null;
};

function EffortBars({ lit, total }: { lit: number; total: number }) {
  return (
    <span aria-hidden className="inline-flex items-end gap-[1.5px]">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} data-lit={i < lit || undefined} className="w-[2px] rounded-sm"
          style={{ height: 4 + i * 2, background: i < lit ? "var(--v2-accent)" : "var(--v2-track)" }} />
      ))}
    </span>
  );
}

/** The live mode rows: one switch at a time, the row in flight spins and further clicks are ignored (#14022). */
function ModeRows({ p, close, busy, setBusy }: {
  p: Composer2Props; close: () => void; busy: string | null; setBusy: (v: string | null) => void;
}) {
  const pick = (value: string) => {
    if (busy) return;
    if (value === p.mode) { close(); return; }
    setBusy(value);
    const done = () => { setBusy(null); close(); };
    p.onModeChange?.(value).then(done, done);
  };
  return (<>
    <MenuHeading>Mode{p.mode == null ? p.modeReading ? " · reading…" : " · not read yet" : ""}</MenuHeading>
    {p.modeChoices?.map(c => (
      <ChoiceRow key={c.value} choice={c} current={c.value === p.mode} busy={busy === c.value}
        leading={<ChoiceIcon choice={c} size={14} />} onPick={() => pick(c.value)} />
    ))}
  </>);
}

/** Who answers, its live mode, and what it may do without asking; the menu lists both with what they mean. */
function AgentChip(p: Composer2Props) {
  const who = seatLabel(p.agent);
  // Held here, not in the menu, so closing and reopening mid-switch cannot start a second one.
  const [busy, setBusy] = useState<string | null>(null);
  const current = p.permissionChoices?.find(c => c.value === p.permission);
  const canPick = !!current && !!p.onPermissionChange;
  const hasMode = p.mode !== undefined && !!p.modeChoices?.length && !!p.onModeChange;
  const modeNow = p.modeChoices?.find(c => c.value === p.mode);
  const modeName = modeNow ? modeNow.short ?? modeNow.label : p.modeReading ? "Reading mode…" : "Mode unknown";
  const parts = [who, hasMode ? `mode: ${modeName}` : null, current ? `permission: ${current.label}` : null].filter(Boolean);
  const label = parts.length > 1 ? parts.join(", ") : `Answers: ${who}`;
  return (
    <ChipMenu group="agent" label={label} title={parts.length > 1 ? `${parts.join(" · ")}. Click to change.` : `Answers: ${who}`}
      menuLabel={hasMode ? "Mode and permission" : "Permission level"} className="py-0 pr-[6px] pl-[3px]" onOpen={p.onModeMenuOpen}
      chip={<>
        <Avatar name={p.agent} llm={brandOfModel(p.model.id)} size={20} />
        {hasMode && <span className={`ml-[5px] whitespace-nowrap ${modeNow ? "text-[var(--v2-text)]" : "text-[var(--v2-muted)]"}`}>{modeName}</span>}
        {current && <>
          <span aria-hidden className="px-[3px] text-[var(--v2-muted)]">·</span>
          <span className={`inline-flex items-center ${current.tone === "warn" ? "text-[var(--v2-warn)]" : "text-[var(--v2-text-2)]"}`}><ChoiceIcon choice={current} /></span>
        </>}
      </>}>
      {canPick || hasMode ? close => (<>
        {hasMode && <ModeRows p={p} close={close} busy={busy} setBusy={setBusy} />}
        {canPick && <PermissionRows p={p} who={who} close={close} />}
      </>) : undefined}
    </ChipMenu>
  );
}

function PermissionRows({ p, who, close }: { p: Composer2Props; who: string; close: () => void }) {
  return (<>
    <MenuHeading>{p.permissionHeading ?? `Permission level for ${who}`}</MenuHeading>
    {p.permissionChoices?.map(c => (
      <ChoiceRow key={c.value} choice={c} current={c.value === p.permission} leading={<ChoiceIcon choice={c} size={14} />}
        onPick={() => { close(); if (c.value !== p.permission) p.onPermissionChange?.(c.value); }} />
    ))}
    {p.onPermissionSettings && (
      <button type="button" role="menuitem" onClick={() => { close(); p.onPermissionSettings?.(); }}
        className="v2-hover mt-1 block w-full rounded-lg border-0 border-t border-[var(--v2-edge)] bg-transparent px-2 py-1.5 text-left">
        <span className="block text-v2-base text-[var(--v2-text-2)]">Permission settings…</span>
        <span className="block text-v2-body text-[var(--v2-muted)]">Settings › Autonomy: the level new work starts at, and your rules</span>
      </button>
    )}
  </>);
}

/** The model and how hard it thinks; the menu lists the models and the effort levels by name. */
function ModelChip(p: Composer2Props) {
  const efforts = p.effortChoices ?? [];
  const hasEffort = p.effort !== undefined && efforts.length > 0;
  const at = efforts.findIndex(c => c.value === p.effort);
  const effortName = at >= 0 ? efforts[at].label : "Effort";
  const canModel = !!p.modelChoices?.length && !!p.onModelChange;
  const canEffort = hasEffort && !!p.onEffortChange;
  const label = hasEffort ? `Model: ${p.model.label}, effort: ${at >= 0 ? effortName : "not set"}` : `Model: ${p.model.label}`;
  return (
    <ChipMenu group="model" label={label} title={`Model: ${p.model.id}${hasEffort ? ` · effort ${at >= 0 ? effortName : "not set"}` : ""}${canModel || canEffort ? ". Click to change." : ""}`}
      menuLabel="Model and effort" className="shrink py-0 pr-[7px] pl-[8px]"
      chip={<>
        <span aria-hidden className="h-[8px] w-[8px] flex-none rounded-full" style={{ background: modelHue(p.model.id) }} />
        <span className="ml-[5px] truncate text-[var(--v2-text)]">{p.model.label}</span>
        {hasEffort && <>
          <span aria-hidden className="px-[5px] text-[var(--v2-muted)]">·</span>
          <EffortBars lit={at + 1} total={efforts.length} />
          <span className={`ml-[5px] flex-none whitespace-nowrap ${at >= 0 ? "text-[var(--v2-text-2)]" : "text-[var(--v2-muted)]"}`}>{effortName}</span>
        </>}
      </>}>
      {canModel || canEffort ? close => (<>
        {canModel && <>
          <MenuHeading>Model</MenuHeading>
          {p.modelChoices?.map(c => (
            <ChoiceRow key={c.value} choice={c} current={c.value === p.modelValue}
              leading={<span aria-hidden className="mt-[3px] block h-[8px] w-[8px] rounded-full" style={{ background: modelHue(p.model.id) }} />}
              onPick={() => { close(); p.onModelChange?.(c.value); }} />
          ))}
        </>}
        {canEffort && <>
          <MenuHeading>Effort{at < 0 ? " · not set from here yet" : ""}</MenuHeading>
          <LevelPills label="Effort" choices={efforts} value={p.effort ?? null} onPick={v => p.onEffortChange?.(v)} />
        </>}
      </>) : undefined}
    </ChipMenu>
  );
}

// #14254: the box starts at two lines and grows with the text up to this height, then scrolls.
const MAX_BOX_PX = 240;

export function Composer2(p: Composer2Props) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    // A zero reading means no layout (tests, a hidden pane): the two rows stand.
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, MAX_BOX_PX)}px`;
  }, [p.value]);
  const text = p.value.trim();
  const blocked = !!p.disabledReason;
  const att = p.attachments;
  const picker = useRef<HTMLInputElement>(null);
  const hasChips = !!att?.chips.length;
  const send = () => { if ((text || hasChips) && !blocked) p.onSend(text); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // #14487: Esc stops the running turn the way the button does. The parent sets onStop only
    // while a turn runs with nothing to queue, so the key and the button are always ONE action.
    if (e.key === "Escape" && p.onStop) { e.preventDefault(); p.onStop(); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };
  return (
    <div ref={att?.rootRef} data-v2-composer className="v2-composer isolate flex min-w-0 flex-col gap-1.5 rounded-xl px-2.5 pt-2.5 pb-2">
      {p.busy && <span className="v2-composer-sweep" aria-hidden="true"><span className="v2-sweep" /></span>}
      <label htmlFor={id} className="sr-only">{p.label}</label>
      <textarea id={id} ref={box} rows={2} value={p.value} placeholder={p.placeholder}
        onChange={e => p.onChange(e.target.value)} onKeyDown={onKey} onPaste={att?.onPaste}
        className="v2-composer-field resize-none overflow-y-auto border-0 bg-transparent p-[2px] text-v2-base text-[var(--v2-text)] placeholder:text-[var(--v2-muted)]" />
      {att && <AttachmentRow chips={att.chips} onRemove={att.remove} />}
      {att?.error && <div role="status" className="text-v2-small text-[var(--v2-warn)]">{att.error}</div>}
      <div className="relative flex min-w-0 items-center gap-1.5">
        <AgentChip {...p} />
        <ModelChip {...p} />
        <span className="min-w-0 flex-1" />
        {p.contextPct != null && <Ring pct={p.contextPct} />}
        {att && <input ref={picker} type="file" accept="image/*" multiple hidden aria-label="Choose images to attach"
          onChange={e => { att.pick(Array.from(e.target.files ?? [])); e.target.value = ""; }} />}
        {(att || p.onAttach) && <IconButton label="Attach a file or image"
          title={att ? "Attach images (drop or paste any file or image onto the box)" : "Attach"}
          round onClick={att ? () => picker.current?.click() : p.onAttach}><Paperclip size={14} aria-hidden /></IconButton>}
        {/* #14487: one action slot, two states — the classic composer's #5556 pattern. While the
            parent says a turn is running (onStop set) the slot stops it in warn amber; Esc and the
            click ride the same handler, and the button never sits beside a Send. */}
        {p.onStop ? (
          <button type="button" aria-label="Stop" title="Interrupt this turn (Esc)" onClick={p.onStop}
            className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border-0 bg-[var(--v2-warn)] text-[var(--v2-warn-ink)]">
            <Square size={12} strokeWidth={2.5} fill="currentColor" aria-hidden />
          </button>
        ) : (
          <button type="button" aria-label="Send" title={p.disabledReason || (text || hasChips ? "Send (Enter)" : "Type a message to send")}
            disabled={(!text && !hasChips) || blocked} onClick={send}
            className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border-0 bg-[var(--v2-text)] text-[var(--v2-ink)] disabled:opacity-40">
            <ArrowUp size={14} strokeWidth={2.4} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
