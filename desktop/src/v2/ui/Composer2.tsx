import { useId, useRef, type KeyboardEvent } from "react";
import { ArrowUp, Paperclip } from "lucide-react";
import { Avatar } from "./Avatar";
import { IconButton } from "./IconButton";
import { Ring } from "./Ring";
import { brandOfModel, modelHue, seatLabel } from "./identity";
import { AttachmentRow } from "./AttachmentRow";
import type { AttachmentsApi } from "./useAttachments";
import { ChipMenu, ChoiceIcon, ChoiceRow, LevelPills, MenuHeading, type Choice } from "./ComposerMenu";

export type { Choice } from "./ComposerMenu";

export type Composer2Props = {
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
  /** Omit where there is no permission level to show. */
  permission?: string;
  permissionChoices?: readonly Choice[];
  onPermissionChange?: (value: string) => void;
  /** Opens the settings page behind the permission menu's last row. */
  onPermissionSettings?: () => void;
  /** Context window used, 0 to 100; null hides the ring (not reported yet). */
  contextPct: number | null;
  onAttach?: () => void;
  /** Chips, drop, paste and picker (#13984 drill); omit and the paperclip stays as `onAttach` says. */
  attachments?: AttachmentsApi;
  /** Disables sending and says why. */
  disabledReason?: string | null;
};

function EffortBars({ lit, total }: { lit: number; total: number }) {
  return (
    <span aria-hidden className="inline-flex items-end gap-[1.5px]">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} data-lit={i < lit || undefined} className="w-[2px] rounded-[1px]"
          style={{ height: 4 + i * 2, background: i < lit ? "var(--v2-accent)" : "var(--v2-track)" }} />
      ))}
    </span>
  );
}

/** Who answers and what it may do without asking; the menu lists every permission level with what it means. */
function AgentChip(p: Composer2Props) {
  const who = seatLabel(p.agent);
  const current = p.permissionChoices?.find(c => c.value === p.permission);
  const canPick = !!current && !!p.onPermissionChange;
  const label = current ? `${who}, permission: ${current.label}` : `Answers: ${who}`;
  return (
    <ChipMenu group="agent" label={label} title={current ? `${who} · ${current.label}. Click to change.` : `Answers: ${who}`}
      menuLabel="Permission level" className="py-[2px] pr-[6px] pl-[3px]"
      chip={<>
        <Avatar name={p.agent} llm={brandOfModel(p.model.id)} size={20} />
        {current && <>
          <span aria-hidden className="px-[3px] text-[var(--v2-muted)]">·</span>
          <span className={`inline-flex items-center ${current.tone === "warn" ? "text-[var(--v2-warn)]" : "text-[var(--v2-text-2)]"}`}><ChoiceIcon choice={current} /></span>
        </>}
      </>}>
      {canPick ? close => (<>
        <MenuHeading>Permission level for {who}</MenuHeading>
        {p.permissionChoices?.map(c => (
          <ChoiceRow key={c.value} choice={c} current={c.value === p.permission} leading={<ChoiceIcon choice={c} size={14} />}
            onPick={() => { close(); if (c.value !== p.permission) p.onPermissionChange?.(c.value); }} />
        ))}
        {p.onPermissionSettings && (
          <button type="button" role="menuitem" onClick={() => { close(); p.onPermissionSettings?.(); }}
            className="v2-hover mt-1 block w-full rounded-[8px] border-0 border-t border-[var(--v2-edge)] bg-transparent px-2 py-1.5 text-left">
            <span className="block text-[12.5px] text-[var(--v2-text-2)]">Permission settings…</span>
            <span className="block text-[11.5px] text-[var(--v2-muted)]">Settings › Autonomy: the level new work starts at, and your rules</span>
          </button>
        )}
      </>) : undefined}
    </ChipMenu>
  );
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
      menuLabel="Model and effort" className="shrink py-[3px] pr-[7px] pl-[8px]"
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

export function Composer2(p: Composer2Props) {
  const id = useId();
  const text = p.value.trim();
  const blocked = !!p.disabledReason;
  const att = p.attachments;
  const picker = useRef<HTMLInputElement>(null);
  const hasChips = !!att?.chips.length;
  const send = () => { if ((text || hasChips) && !blocked) p.onSend(text); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };
  return (
    <div ref={att?.rootRef} className="flex min-w-0 flex-col gap-2 rounded-[14px] border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-[10px]">
      <label htmlFor={id} className="sr-only">{p.label}</label>
      <textarea id={id} rows={2} value={p.value} placeholder={p.placeholder}
        onChange={e => p.onChange(e.target.value)} onKeyDown={onKey} onPaste={att?.onPaste}
        className="resize-none border-0 bg-transparent p-[2px] text-[12.5px] text-[var(--v2-text)] outline-none placeholder:text-[var(--v2-muted)]" />
      {att && <AttachmentRow chips={att.chips} onRemove={att.remove} />}
      {att?.error && <div role="status" className="text-[11px] text-[var(--v2-warn)]">{att.error}</div>}
      <div className="relative flex min-w-0 items-center gap-1.5">
        <AgentChip {...p} />
        <ModelChip {...p} />
        <span className="min-w-0 flex-1" />
        {p.contextPct != null && <Ring pct={p.contextPct} />}
        {att && <input ref={picker} type="file" accept="image/*" multiple hidden aria-label="Choose images to attach"
          onChange={e => { att.pick(Array.from(e.target.files ?? [])); e.target.value = ""; }} />}
        <IconButton label="Attach a file or image"
          title={att ? "Attach images (drop or paste any file or image onto the box)" : p.onAttach ? "Attach" : "Attaching is not wired here yet"}
          round disabled={!att && !p.onAttach} onClick={att ? () => picker.current?.click() : p.onAttach}><Paperclip size={14} aria-hidden /></IconButton>
        <button type="button" aria-label="Send" title={p.disabledReason || (text || hasChips ? "Send (Enter)" : "Type a message to send")}
          disabled={(!text && !hasChips) || blocked} onClick={send}
          className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border-0 bg-[var(--v2-text)] text-[var(--v2-ink)] disabled:opacity-40">
          <ArrowUp size={14} strokeWidth={2.4} aria-hidden />
        </button>
      </div>
    </div>
  );
}
