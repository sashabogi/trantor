// A readable diff from git's own unified output (#13988): code lines never wrap, they scroll
// sideways. Combined is one column; Side by side pairs deletions with additions.
import { useEffect, useState, type MouseEvent } from "react";
import { FileText, History } from "lucide-react";
import { Seg } from "../../ui/Seg";
import { IconButton } from "../../ui/IconButton";
import { Button } from "../../ui/Button";
import { hunkText, pairHunk, patchForHunk, patchForLines, type DiffFile, type DiffHunk, type DiffLine } from "./diff";
import { StatusLetter } from "./parts";
import type { ChangeSide } from "./model";
import { scopeBlame, type GitBlameLine, type GitPatchAction } from "./scopeGitApi";
import { FileHistoryControl } from "./HistoryView";

export type DiffLayout = "combined" | "split";
export type ApplyPatch = (patch: string, action: GitPatchAction, path: string) => Promise<void>;

const ROW_BG = { add: "var(--v2-diff-add)", del: "var(--v2-diff-del)", ctx: "transparent" } as const;
const SIGN = { add: "+", del: "-", ctx: " " } as const;

type LineSelect = (index: number, shift: boolean) => void;

/** One file's line history at HEAD, keyed by the old side's line numbers (#14237). */
type Blame = { lines: Map<number, GitBlameLine> | null; error: string | null };

function Gutter({ n }: { n: number | null }) {
  return <span className="w-[34px] shrink-0 select-none pr-1.5 text-right text-v2-small text-[var(--v2-track)]">{n ?? ""}</span>;
}

// #14237: the history cell leads its own diff row, so it lines up and stays in view whatever the line length.
// Blame is read at HEAD, so a row is matched by its old line number and an added line has no author yet.
function BlameCell({ line, uncommitted = false }: { line: GitBlameLine | null; uncommitted?: boolean }) {
  return (
    <span data-blame-cell title={line ? `${line.subject} · ${line.sha}` : undefined}
      className="v2-mono flex h-[19px] w-[190px] shrink-0 select-none items-center gap-1.5 overflow-hidden whitespace-nowrap border-r border-[var(--v2-edge)] px-2 text-v2-micro text-[var(--v2-muted)]">
      {!line && uncommitted && <span className="min-w-0 flex-1 truncate">not committed</span>}
      {line && <>
        <span className="min-w-0 flex-1 truncate text-[var(--v2-text-2)]">{line.author}</span>
        <span className="shrink-0">{line.when}</span>
        <span className="shrink-0 text-[var(--v2-accent)]">{line.sha.slice(0, 7)}</span>
      </>}
    </span>
  );
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

function CombinedLine({ l, index, selected, onSelect, blame }: { l: DiffLine; index: number; selected: boolean; onSelect?: LineSelect; blame?: Map<number, GitBlameLine> | null }) {
  const interactive = l.kind !== "ctx" ? selectionProps(index, onSelect) : {};
  return (
    <div data-kind={l.kind} data-selected={selected || undefined} {...interactive}
      className="v2-mono flex min-w-max whitespace-pre text-v2-body leading-[19px] data-[selected=true]:outline data-[selected=true]:outline-1 data-[selected=true]:-outline-offset-1 data-[selected=true]:outline-[var(--v2-accent)]"
      style={{ background: ROW_BG[l.kind] }}>
      {blame !== undefined && <BlameCell line={blame?.get(l.oldNo ?? -1) ?? null} uncommitted={!!blame && l.kind === "add"} />}
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
      className="v2-mono flex min-w-0 flex-1 basis-1/2 whitespace-pre text-v2-body leading-[19px] data-[selected=true]:outline data-[selected=true]:outline-1 data-[selected=true]:-outline-offset-1 data-[selected=true]:outline-[var(--v2-accent)]"
      style={{ background: l ? ROW_BG[l.kind === "ctx" ? "ctx" : side === "left" ? "del" : "add"] : "transparent" }}>
      <Gutter n={l ? (side === "left" ? l.oldNo : l.newNo) : null} />
      <span className="pr-4 text-[var(--v2-text-2)]">{l?.text ?? ""}</span>
    </div>
  );
}

function PatchButton({ action, unit, busy, onRun }: { action: GitPatchAction; unit: string; busy: boolean; onRun: (action: GitPatchAction) => void }) {
  const label = `${action === "stage" ? "Stage" : action === "unstage" ? "Unstage" : "Discard"} ${unit}`;
  return <Button variant={action === "discard" ? "danger" : "quiet"} className="!px-2 !py-0.5 !text-v2-small" disabledReason={busy ? "Applying patch" : null} onClick={() => onRun(action)}>{label}</Button>;
}

// #14268: staged changes offer Unstage, unstaged ones Stage and Discard; a path on both sides offers all three.
const ACTIONS = { staged: ["unstage"], unstaged: ["stage", "discard"], both: ["stage", "unstage", "discard"] } as const satisfies Record<ChangeSide, readonly GitPatchAction[]>;

function HunkBlock({ file, hunk, layout, busy, onAddToChat, onApply, blame, side = "both" }: {
  file: DiffFile; hunk: DiffHunk; layout: DiffLayout; busy: boolean; onAddToChat: (text: string) => void; onApply?: ApplyPatch; blame?: Blame; side?: ChangeSide;
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
  // #14237: one button per action; the selection decides whether it patches the hunk or the lines.
  const unit = selected.size === 0 ? "hunk" : `${selected.size} ${selected.size === 1 ? "line" : "lines"}`;
  const run = (action: GitPatchAction) => {
    if (!onApply) return;
    setError(null);
    const byLine = selected.size > 0;
    let patch: string;
    try { patch = byLine ? patchForLines(file, hunk, selected, action !== "stage") : patchForHunk(file, hunk); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    void onApply(patch, action, file.path)
      .then(() => { setSelected(new Set()); setAnchor(null); })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  return (
    <div>
      <div className="v2-mono sticky left-0 flex min-w-max items-center gap-2 border-y border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-3 py-1 text-v2-small text-[var(--v2-muted)] whitespace-nowrap">
        <span className="min-w-[120px] flex-1">{hunk.header}</span>
        <Button variant="quiet" className="!px-2 !py-0.5 !text-v2-small" onClick={() => onAddToChat(hunkText(file, hunk))} title="Attach this hunk to the chat">Add to chat</Button>
        {onApply && ACTIONS[side].map(action => <PatchButton key={action} action={action} unit={unit} busy={busy} onRun={run} />)}
      </div>
      {blame && !blame.lines && !blame.error && <div className="px-3 py-1 text-v2-small text-[var(--v2-muted)]">Reading blame</div>}
      {blame?.error && <div role="alert" className="px-3 py-1 text-v2-small text-[var(--v2-bad)]">{blame.error}</div>}
      {error && <div role="alert" className="border-b border-[var(--v2-edge)] px-3 py-1.5 text-v2-body text-[var(--v2-bad)]">{error}</div>}
      {layout === "combined"
        ? hunk.lines.map((l, i) => <CombinedLine key={i} l={l} index={i} selected={selected.has(i)} onSelect={onApply ? select : undefined} blame={blame?.lines} />)
        : <div className="min-w-max">{pairHunk(hunk).map((r, i) => {
          const left = r.left ? hunk.lines.indexOf(r.left) : undefined;
          const right = r.right ? hunk.lines.indexOf(r.right) : undefined;
          return <div key={i} className="flex">
            {blame === undefined ? null : <BlameCell line={blame?.lines?.get(r.left?.oldNo ?? -1) ?? null} uncommitted={!!blame.lines && !r.left && !!r.right} />}
            <SplitCell l={r.left} side="left" index={left} selected={left !== undefined && selected.has(left)} onSelect={onApply ? select : undefined} />
            <div className="w-px shrink-0 bg-[var(--v2-edge)]" />
            <SplitCell l={r.right} side="right" index={right} selected={right !== undefined && selected.has(right)} onSelect={onApply ? select : undefined} />
          </div>;
        })}</div>}
    </div>
  );
}

function FileHeader({ file, layout, onLayout, onOpenFile, project, scope, lineOn, onLineHistory }: {
  file: DiffFile; layout: DiffLayout; onLayout: (l: DiffLayout) => void; onOpenFile?: (path: string) => void;
  project?: string; scope?: string | null; lineOn: boolean; onLineHistory: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--v2-edge)] px-3 py-2">
      <StatusLetter letter={file.status} />
      <span className="v2-mono min-w-0 flex-1 truncate text-v2-body text-[var(--v2-text)]">{file.path}</span>
      <Seg label="Diff layout" value={layout} onChange={onLayout} options={[{ value: "combined", label: "Combined" }, { value: "split", label: "Side by side" }]} />
      {onOpenFile && <IconButton label="Open file in editor" title={file.status === "D" ? "The deleted file cannot be opened" : "Open the file"} size={24} disabled={file.status === "D"} onClick={() => onOpenFile(file.path)}><FileText size={13} aria-hidden /></IconButton>}
      {project && <FileHistoryControl project={project} scope={scope ?? null} path={file.path} />}
      {project && <IconButton label="Line history" title="Show author, age and commit beside every line" size={24} aria-pressed={lineOn} onClick={onLineHistory}><History size={13} aria-hidden /></IconButton>}
    </div>
  );
}

/** The hunks of one file, with the optional blame column threaded onto every row (#14237). */
function DiffBody({ file, layout, busy, onAddToChat, apply, blame, side }: {
  file: DiffFile; layout: DiffLayout; busy: boolean; onAddToChat: (text: string) => void; apply?: ApplyPatch; blame?: Blame; side?: ChangeSide;
}) {
  return (
    <div className="min-w-0">
      {file.binary && <div className="px-4 py-3 text-v2-body text-[var(--v2-muted)]">Binary file: git shows no text diff.</div>}
      {file.hunks.map(h => <HunkBlock key={h.header} file={file} hunk={h} layout={layout} busy={busy} onAddToChat={onAddToChat} onApply={apply} blame={blame} side={side} />)}
    </div>
  );
}

/** The diff with line history on: blame is fetched once per file and rides on the diff rows. */
function BlamedDiffBody({ file, layout, busy, onAddToChat, apply, project, scope, side }: {
  file: DiffFile; layout: DiffLayout; busy: boolean; onAddToChat: (text: string) => void; apply?: ApplyPatch; project: string; scope: string | null; side?: ChangeSide;
}) {
  const [lines, setLines] = useState<GitBlameLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLines(null);
    setError(null);
    scopeBlame(project, scope, file.path)
      .then(value => { if (alive) setLines(value); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; };
  }, [project, scope, file.path]);
  const blame: Blame = { lines: lines === null ? null : new Map(lines.map(entry => [entry.line, entry] as const)), error };
  return (
    <div role="group" aria-label={`Line history: ${file.path}`} className="min-w-0">
      <DiffBody file={file} layout={layout} busy={busy} onAddToChat={onAddToChat} apply={apply} blame={blame} side={side} />
    </div>
  );
}

export function DiffView({ files, layout, onLayout, onAddToChat, onOpenFile, onApply, project, scope, sideOf }: {
  files: DiffFile[]; layout: DiffLayout; onLayout: (l: DiffLayout) => void; onAddToChat: (text: string) => void; onOpenFile?: (path: string) => void; onApply?: ApplyPatch;
  project?: string; scope?: string | null; sideOf?: (path: string) => ChangeSide;
}) {
  const [busy, setBusy] = useState(false);
  const [blamePath, setBlamePath] = useState<string | null>(null);
  const apply: ApplyPatch = async (patch, action, path) => {
    if (!onApply) return;
    setBusy(true);
    try { await onApply(patch, action, path); }
    finally { setBusy(false); }
  };
  if (files.length === 0) return <div className="px-4 py-6 text-v2-base text-[var(--v2-muted)]">No diff for this selection.</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-diff-scroll>
      {files.map(file => (
        <section key={file.path} aria-label={`Diff of ${file.path}`} className="flex flex-col">
          <FileHeader file={file} layout={layout} onLayout={onLayout} onOpenFile={onOpenFile} project={project} scope={scope}
            lineOn={blamePath === file.path} onLineHistory={() => setBlamePath(path => path === file.path ? null : file.path)} />
          {project && blamePath === file.path
            ? <BlamedDiffBody file={file} layout={layout} busy={busy} onAddToChat={onAddToChat} apply={onApply ? apply : undefined} project={project} scope={scope ?? null} side={sideOf?.(file.path)} />
            : <DiffBody file={file} layout={layout} busy={busy} onAddToChat={onAddToChat} apply={onApply ? apply : undefined} side={sideOf?.(file.path)} />}
        </section>
      ))}
    </div>
  );
}
