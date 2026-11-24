import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, ChevronDown, Paperclip, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { Avatar } from "./Avatar";
import { IconButton } from "./IconButton";
import { Ring } from "./Ring";
import { brandOfModel, modelHue, seatLabel } from "./identity";
import { AttachmentRow } from "./AttachmentRow";
import type { AttachmentsApi } from "./useAttachments";

export type Effort = 0 | 1 | 2 | 3;
export const EFFORT_LABELS = ["low", "medium", "high", "max"] as const;
const EFFORTS: readonly Effort[] = [0, 1, 2, 3];

export type Permission = "ask" | "guarded" | "auto";
export const PERMISSIONS = {
  ask: { short: "asks first", title: "Permission: asks before every edit and command" },
  guarded: { short: "asks before irreversible actions", title: "Permission: edits freely, asks before irreversible actions" },
  auto: { short: "full auto", title: "Permission: full auto. Runs without asking, except the always-ask list (force-push, deleting trees, credentials)" },
} as const satisfies Record<Permission, { short: string; title: string }>;
const PERMISSION_ORDER: readonly Permission[] = ["ask", "guarded", "auto"];

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
  onAgentClick?: () => void;
  /** Model id ("claude-opus-5-5") and the short label shown ("opus 5.5"). */
  model: { id: string; label: string };
  onModelClick?: () => void;
  effort: Effort;
  onEffortChange?: (effort: Effort) => void;
  showEffort?: boolean;
  permission: Permission;
  onPermissionChange?: (permission: Permission) => void;
  showPermission?: boolean;
  /** Context window used, 0 to 100; null hides the ring (not reported yet). */
  contextPct: number | null;
  onAttach?: () => void;
  /** Chips, drop, paste and picker (#13984 drill); omit and the paperclip stays as `onAttach` says. */
  attachments?: AttachmentsApi;
  /** Disables sending and says why. */
  disabledReason?: string | null;
};

/** A clickable control when it has a handler, a plain label when it does not (#v2-F). */
function Control({ onClick, label, title, className, children }: {
  onClick?: () => void; label?: string; title: string; className: string; children: ReactNode;
}) {
  if (!onClick) return <span aria-label={label} title={title} className={className}>{children}</span>;
  return <button type="button" aria-label={label} title={title} onClick={onClick} className={`${className} v2-hover`}>{children}</button>;
}

function EffortBars({ effort }: { effort: Effort }) {
  return (
    <>
      {[4, 6, 8, 10].map((h, i) => (
        <span key={h} data-lit={i <= effort || undefined} className="w-[2px] rounded-[1px]"
          style={{ height: h, background: i <= effort ? "var(--v2-accent)" : "var(--v2-track)" }} />
      ))}
    </>
  );
}

function PermissionIcon({ permission }: { permission: Permission }) {
  if (permission === "auto") return <ShieldAlert size={13} aria-hidden />;
  if (permission === "guarded") return <ShieldCheck size={13} aria-hidden />;
  return <Shield size={13} aria-hidden />;
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
  const effortName = EFFORT_LABELS[p.effort];
  const perm = PERMISSIONS[p.permission];
  const nextEffort = () => p.onEffortChange?.(EFFORTS[(p.effort + 1) % EFFORTS.length]);
  const nextPermission = () =>
    p.onPermissionChange?.(PERMISSION_ORDER[(PERMISSION_ORDER.indexOf(p.permission) + 1) % PERMISSION_ORDER.length]);
  return (
    <div ref={att?.rootRef} className="flex min-w-0 flex-col gap-2 rounded-[14px] border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-[10px]">
      <label htmlFor={id} className="sr-only">{p.label}</label>
      <textarea id={id} rows={2} value={p.value} placeholder={p.placeholder}
        onChange={e => p.onChange(e.target.value)} onKeyDown={onKey} onPaste={att?.onPaste}
        className="resize-none border-0 bg-transparent p-[2px] text-[12.5px] text-[var(--v2-text)] outline-none placeholder:text-[var(--v2-muted)]" />
      {att && <AttachmentRow chips={att.chips} onRemove={att.remove} />}
      {att?.error && <div role="status" className="text-[11px] text-[var(--v2-warn)]">{att.error}</div>}
      <div className="flex min-w-0 items-center gap-1.5">
        {/* #13984 drill: two chips, like every agent composer: who answers and its permission, then model and effort. */}
        <div data-group="agent" className="inline-flex min-w-0 flex-none items-center rounded-full border border-[var(--v2-edge-2)] bg-[var(--v2-raised)] text-[11.5px] font-medium py-[2px] pr-[3px] pl-[3px]">
          <Control onClick={p.onAgentClick} label={`Answers: ${seatLabel(p.agent)}`} title={`Answers: ${seatLabel(p.agent)}`}
            className="inline-flex items-center gap-[3px] rounded-full border-0 bg-transparent">
            <Avatar name={p.agent} llm={brandOfModel(p.model.id)} size={20} />{p.onAgentClick && <ChevronDown size={9} aria-hidden />}
          </Control>
          {(p.showPermission ?? true) && <>
            <span aria-hidden className="px-[2px] text-[var(--v2-muted)]">·</span>
            <Control onClick={p.onPermissionChange && nextPermission} label={`Permission: ${perm.short}`} title={perm.title}
              className={`inline-flex h-[20px] w-[22px] items-center justify-center rounded-full border-0 ${
                p.permission === "auto" ? "bg-[var(--v2-warn-soft)] text-[var(--v2-warn)]" : "bg-transparent text-[var(--v2-text-2)]"}`}>
              <PermissionIcon permission={p.permission} />
            </Control>
          </>}
        </div>
        <div data-group="model" className="inline-flex min-w-0 shrink items-center rounded-full border border-[var(--v2-edge-2)] bg-[var(--v2-raised)] text-[11.5px] font-medium py-[2px] pr-[4px] pl-[8px]">
          <Control onClick={p.onModelClick} title={`Model: ${p.model.id}`}
            className="inline-flex min-w-0 items-center gap-[5px] whitespace-nowrap rounded-full border-0 bg-transparent text-[var(--v2-text)]">
            <span aria-hidden className="h-[8px] w-[8px] flex-none rounded-full" style={{ background: modelHue(p.model.id) }} /><span className="truncate">{p.model.label}</span>
          </Control>
          {(p.showEffort ?? true) && <>
            <span aria-hidden className="px-[5px] text-[var(--v2-muted)]">·</span>
            <Control onClick={p.onEffortChange && nextEffort} label={`Effort: ${effortName}`} title={`Effort: ${effortName} (low · medium · high · max)`}
              className="inline-flex h-[20px] flex-none items-center gap-[5px] whitespace-nowrap rounded-full border-0 bg-transparent pr-[5px] text-[var(--v2-text-2)]">
              <span aria-hidden className="inline-flex items-end gap-[1.5px]"><EffortBars effort={p.effort} /></span>
              <span className="capitalize">{effortName}</span>
            </Control>
          </>}
        </div>
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
