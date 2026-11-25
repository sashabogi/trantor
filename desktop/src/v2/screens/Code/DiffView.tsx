// A readable diff from git's own unified output (#13988): code lines never wrap, they scroll
// sideways. Combined is one column; Side by side pairs deletions with additions.
import { useState, type MouseEvent } from "react";
import { FileText, History } from "lucide-react";
import { Seg } from "../../ui/Seg";
import { IconButton } from "../../ui/IconButton";
import { Button } from "../../ui/Button";
import { hunkText, pairHunk, patchForHunk, patchForLines, type DiffFile, type DiffHunk, type DiffLine } from "./diff";
import { StatusLetter } from "./parts";
import type { GitPatchAction } from "./scopeGitApi";

export type DiffLayout = "combined" | "split";
export type ApplyPatch = (patch: string, action: GitPatchAction, path: string) => Promise<void>;

const ROW_BG = { add: "rgba(124,196,154,0.10)", del: "rgba(229,138,138,0.10)", ctx: "transparent" } as const;
const SIGN = { add: "+", del: "-", ctx: " " } as const;

type LineSelect = (index: number, shift: boolean) => void;

function Gutter({ n }: { n: number | null }) {
  return <span className="w-[34px] shrink-0 select-none pr-1.5 text-right text-[10.5px] text-[var(--v2-track)]">{n ?? ""}</span>;
}

function selectionProps(index: number | undefined, onSelect?: LineSelect) {
  if (index === undefined || !onSelect) return {};
  return {
    "data-line-index": index,
    role: "button",
    tabIndex: 0,
    onClick: (event: MouseEvent<HTMLDivElement>) => onSelect(index, event.shiftKey),
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(index, event.shiftKey); }
    },
  };
}

function CombinedLine({ l, index, selected, onSelect }: { l: DiffLine; index: number; selected: boolean; onSelect?: LineSelect }) {
  const interactive = l.kind !== "ctx" ? selectionProps(index, onSelect) : {};
  return (
    <div data-kind={l.kind} data-selected={selected || undefined} {...interactive}
      className="v2-mono flex min-w-max whitespace-pre text-[12px] leading-[19px] data-[selected=true]:outline data-[selected=true]:outline-1 data-[selected=true]:-outline-offset-1 data-[selected=true]:outline-[var(--v2-accent)]"
      style={{ background: ROW_BG[l.kind] }}>
      <Gutter n={l.oldNo} /><Gutter n={l.newNo} />
      <span className="w-3 shrink-0 select-none text-[var(--v2-muted)]">{SIGN[l.kind]}</span>
      <span className="pr-4 text-[var(--v2-text-2)]">{l.text}</span>
    </div>
  );
}

function SplitCell({ l, side, index, selected, onSelect }: { l: DiffLine | null; side: "left" | "right"; index?: number; selected: boolean; onSelect?: LineSelect }) {
  const interactive = l && l.kind !== "ctx" ? selectionProps(index, onSelect) : {};
  return (
    <div {...interactive} data-selected={selected || undefined}
      className="v2-mono flex min-w-0 flex-1 basis-1/2 whitespace-pre text-[12px] leading-[19px] data-[selected=true]:outline data-[selected=true]:outline-1 data-[selected=true]:-outline-offset-1 data-[selected=true]:outline-[var(--v2-accent)]"
      style={{ background: l ? ROW_BG[l.kind === "ctx" ? "ctx" : side === "left" ? "del" : "add"] : "transparent" }}>
      <Gutter n={l ? (side === "left" ? l.oldNo : l.newNo) : null} />
      <span className="pr-4 text-[var(--v2-text-2)]">{l?.text ?? ""}</span>
    </div>
  );
}

function PatchButton({ action, unit, busy, disabled, onRun }: { action: GitPatchAction; unit: "hunk" | "lines"; busy: boolean; disabled?: boolean; onRun: (action: GitPatchAction) => void }) {
  const label = `${action === "stage" ? "Stage" : action === "unstage" ? "Unstage" : "Discard"} ${unit}`;
  const reason = busy ? "Applying patch" : disabled ? `Select at least one changed line` : null;
  return <Button variant={action === "discard" ? "danger" : "quiet"} className="!px-2 !py-0.5 !text-[11px]" disabledReason={reason} onClick={() => onRun(action)}>{label}</Button>;
}

function HunkBlock({ file, hunk, layout, busy, onAddToChat, onApply }: {
  file: DiffFile; hunk: DiffHunk; layout: DiffLayout; busy: boolean; onAddToChat: (text: string) => void; onApply?: ApplyPatch;
}) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const select = (index: number, shift: boolean) => {
    if (shift && anchor !== null) {
      const next = new Set(selected);
      for (let i = Math.min(anchor, index); i <= Math.max(anchor, index); i++) if (hunk.lines[i]?.kind !== "ctx") next.add(i);
      setSelected(next);
    } else {
      const next = new Set(selected);
      if (next.has(index)) next.delete(index); else next.add(index);
      setSelected(next);
      setAnchor(index);
    }
  };
  const run = (action: GitPatchAction, lines = false) => {
    if (!onApply) return;
    setError(null);
    let patch: string;
    try { patch = lines ? patchForLines(file, hunk, selected, action !== "stage") : patchForHunk(file, hunk); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    void onApply(patch, action, file.path)
      .then(() => { setSelected(new Set()); setAnchor(null); })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const patchButton = (action: GitPatchAction, unit: "hunk" | "lines") => <PatchButton action={action} unit={unit} busy={busy} disabled={unit === "lines" && selected.size === 0} onRun={action => run(action, unit === "lines")} />;
  return (
    <div>
      <div className="v2-mono sticky left-0 flex min-w-max items-center gap-2 border-y border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-3 py-1 text-[11px] text-[var(--v2-muted)] whitespace-nowrap">
        <span className="min-w-[120px] flex-1">{hunk.header}</span>
        <Button variant="quiet" className="!px-2 !py-0.5 !text-[11px]" onClick={() => onAddToChat(hunkText(file, hunk))} title="Attach this hunk to the chat">Add to chat</Button>
        {onApply && (["stage", "unstage", "discard"] as const).map(action => <span key={action} className="flex gap-1">{patchButton(action, "hunk")}{patchButton(action, "lines")}</span>)}
      </div>
      {error && <div role="alert" className="border-b border-[var(--v2-edge)] px-3 py-1.5 text-[11.5px] text-[var(--v2-bad)]">{error}</div>}
      {layout === "combined"
        ? hunk.lines.map((l, i) => <CombinedLine key={i} l={l} index={i} selected={selected.has(i)} onSelect={onApply ? select : undefined} />)
        : <div className="min-w-max">{pairHunk(hunk).map((r, i) => {
          const left = r.left ? hunk.lines.indexOf(r.left) : undefined;
          const right = r.right ? hunk.lines.indexOf(r.right) : undefined;
          return <div key={i} className="flex">
            <SplitCell l={r.left} side="left" index={left} selected={left !== undefined && selected.has(left)} onSelect={onApply ? select : undefined} />
            <div className="w-px shrink-0 bg-[var(--v2-edge)]" />
            <SplitCell l={r.right} side="right" index={right} selected={right !== undefined && selected.has(right)} onSelect={onApply ? select : undefined} />
          </div>;
        })}</div>}
    </div>
  );
}

function FileHeader({ file, layout, onLayout, onOpenFile }: { file: DiffFile; layout: DiffLayout; onLayout: (l: DiffLayout) => void; onOpenFile?: (path: string) => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--v2-edge)] px-3 py-2">
      <StatusLetter letter={file.status} />
      <span className="v2-mono min-w-0 flex-1 truncate text-[12px] text-[var(--v2-text)]">{file.path}</span>
      <Seg label="Diff layout" value={layout} onChange={onLayout} options={[{ value: "combined", label: "Combined" }, { value: "split", label: "Side by side" }]} />
      <IconButton label="Open file in editor" title="Open the file" size={24} disabled={!onOpenFile || file.status === "D"} onClick={() => onOpenFile?.(file.path)}><FileText size={13} aria-hidden /></IconButton>
      <IconButton label="Line history" title="Line history needs a git blame command. Not wired yet." size={24} disabled><History size={13} aria-hidden /></IconButton>
    </div>
  );
}

export function DiffView({ files, layout, onLayout, onAddToChat, onOpenFile, onApply }: {
  files: DiffFile[]; layout: DiffLayout; onLayout: (l: DiffLayout) => void; onAddToChat: (text: string) => void; onOpenFile?: (path: string) => void; onApply?: ApplyPatch;
}) {
  const [busy, setBusy] = useState(false);
  const apply: ApplyPatch = async (patch, action, path) => {
    if (!onApply) return;
    setBusy(true);
    try { await onApply(patch, action, path); }
    finally { setBusy(false); }
  };
  if (files.length === 0) return <div className="px-4 py-6 text-[12.5px] text-[var(--v2-muted)]">No diff for this selection.</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-diff-scroll>
      {files.map(file => (
        <section key={file.path} aria-label={`Diff of ${file.path}`} className="flex flex-col">
          <FileHeader file={file} layout={layout} onLayout={onLayout} onOpenFile={onOpenFile} />
          {file.binary && <div className="px-4 py-3 text-[12px] text-[var(--v2-muted)]">Binary file: git shows no text diff.</div>}
          {file.hunks.map(h => <HunkBlock key={h.header} file={file} hunk={h} layout={layout} busy={busy} onAddToChat={onAddToChat} onApply={onApply ? apply : undefined} />)}
        </section>
      ))}
    </div>
  );
}
