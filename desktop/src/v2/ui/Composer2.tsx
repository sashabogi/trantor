import { useId, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, ChevronDown, Paperclip, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { Avatar } from "./Avatar";
import { IconButton } from "./IconButton";
import { Ring } from "./Ring";
import { modelHue, seatLabel } from "./identity";

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
  permission: Permission;
  onPermissionChange?: (permission: Permission) => void;
  /** Context window used, 0 to 100; null hides the ring (not reported yet). */
  contextPct: number | null;
  onAttach?: () => void;
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
      {[6, 10, 14, 18].map((h, i) => (
        <span key={h} data-lit={i <= effort || undefined} className="w-[3px] rounded-[1px]"
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
  const send = () => { if (text && !blocked) p.onSend(text); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };
  const effortName = EFFORT_LABELS[p.effort];
  const perm = PERMISSIONS[p.permission];
  const nextEffort = () => p.onEffortChange?.(EFFORTS[(p.effort + 1) % EFFORTS.length]);
  const nextPermission = () =>
    p.onPermissionChange?.(PERMISSION_ORDER[(PERMISSION_ORDER.indexOf(p.permission) + 1) % PERMISSION_ORDER.length]);
  return (
    <div className="flex flex-col gap-2 rounded-[14px] border border-[var(--v2-edge-2)] bg-[var(--v2-panel-2)] p-[10px]">
      <label htmlFor={id} className="sr-only">{p.label}</label>
      <textarea id={id} rows={2} value={p.value} placeholder={p.placeholder}
        onChange={e => p.onChange(e.target.value)} onKeyDown={onKey}
        className="resize-none border-0 bg-transparent p-[2px] text-[12.5px] text-[var(--v2-text)] outline-none placeholder:text-[var(--v2-muted)]" />
      <div className="flex items-center gap-1.5">
        <Control onClick={p.onAgentClick} title="Who answers: the orchestrator, a seat, or a new agent"
          className="inline-flex flex-none items-center gap-[5px] whitespace-nowrap rounded-full border border-[var(--v2-edge-2)] bg-[var(--v2-raised)] py-[3px] pr-2 pl-[3px] text-[11.5px] font-medium text-[var(--v2-text)]">
          <Avatar name={p.agent} size={18} />{seatLabel(p.agent)}{p.onAgentClick && <ChevronDown size={9} aria-hidden />}
        </Control>
        <Control onClick={p.onModelClick} title={`Model: ${p.model.id}`}
          className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-md border-0 bg-transparent px-1 py-[3px] text-[11.5px] font-medium text-[var(--v2-text-2)]">
          <span aria-hidden className="h-[9px] w-[9px] rounded-full" style={{ background: modelHue(p.model.id) }} />{p.model.label}
        </Control>
        <Control onClick={p.onEffortChange && nextEffort} label={`Effort: ${effortName}`} title={`Effort: ${effortName} (low · medium · high · max)`}
          className="inline-flex h-5 items-end gap-[2px] rounded border-0 bg-transparent px-1">
          <EffortBars effort={p.effort} />
        </Control>
        <Control onClick={p.onPermissionChange && nextPermission} label={`Permission: ${perm.short}`} title={perm.title}
          className={`inline-flex h-[26px] w-[26px] items-center justify-center rounded-full border-0 ${
            p.permission === "auto" ? "bg-[var(--v2-warn-soft)] text-[var(--v2-warn)]" : "bg-transparent text-[var(--v2-text-2)]"}`}>
          <PermissionIcon permission={p.permission} />
        </Control>
        <span className="flex-1" />
        {p.contextPct != null && <Ring pct={p.contextPct} />}
        <IconButton label="Attach a file or image" title={p.onAttach ? "Attach" : "Attaching is not wired here yet"}
          round disabled={!p.onAttach} onClick={p.onAttach}><Paperclip size={14} aria-hidden /></IconButton>
        <button type="button" aria-label="Send" title={p.disabledReason || (text ? "Send (Enter)" : "Type a message to send")}
          disabled={!text || blocked} onClick={send}
          className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border-0 bg-[var(--v2-text)] text-[var(--v2-ink)] disabled:opacity-40">
          <ArrowUp size={14} strokeWidth={2.4} aria-hidden />
        </button>
      </div>
    </div>
  );
}
