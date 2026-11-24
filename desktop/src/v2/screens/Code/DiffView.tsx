// A readable diff from git's own unified output (#13988): code lines never wrap, they scroll
// sideways. Combined is one column; Side by side pairs deletions with additions.
import { FileText, History } from "lucide-react";
import { Seg } from "../../ui/Seg";
import { IconButton } from "../../ui/IconButton";
import { Button } from "../../ui/Button";
import { hunkText, pairHunk, type DiffFile, type DiffHunk, type DiffLine } from "./diff";
import { StatusLetter } from "./parts";

export type DiffLayout = "combined" | "split";

const ROW_BG = { add: "rgba(124,196,154,0.10)", del: "rgba(229,138,138,0.10)", ctx: "transparent" } as const;
const SIGN = { add: "+", del: "-", ctx: " " } as const;
const STAGE_HUNK_REASON = "Staging one hunk needs git apply --cached, which no command runs yet.";

function Gutter({ n }: { n: number | null }) {
  return <span className="w-[34px] shrink-0 select-none pr-1.5 text-right text-[10.5px] text-[var(--v2-track)]">{n ?? ""}</span>;
}

function CombinedLine({ l }: { l: DiffLine }) {
  return (
    <div data-kind={l.kind} className="v2-mono flex min-w-max whitespace-pre text-[12px] leading-[19px]" style={{ background: ROW_BG[l.kind] }}>
      <Gutter n={l.oldNo} /><Gutter n={l.newNo} />
      <span className="w-3 shrink-0 select-none text-[var(--v2-muted)]">{SIGN[l.kind]}</span>
      <span className="pr-4 text-[var(--v2-text-2)]">{l.text}</span>
    </div>
  );
}

function SplitCell({ l, side }: { l: DiffLine | null; side: "left" | "right" }) {
  return (
    <div className="v2-mono flex min-w-0 flex-1 basis-1/2 whitespace-pre text-[12px] leading-[19px]" style={{ background: l ? ROW_BG[l.kind === "ctx" ? "ctx" : side === "left" ? "del" : "add"] : "transparent" }}>
      <Gutter n={l ? (side === "left" ? l.oldNo : l.newNo) : null} />
      <span className="pr-4 text-[var(--v2-text-2)]">{l?.text ?? ""}</span>
    </div>
  );
}

function HunkBlock({ file, hunk, layout, onAddToChat }: { file: DiffFile; hunk: DiffHunk; layout: DiffLayout; onAddToChat: (text: string) => void }) {
  return (
    <div>
      <div className="v2-mono sticky left-0 flex min-w-max items-center gap-3 border-y border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-3 py-1 text-[11px] text-[var(--v2-muted)] whitespace-nowrap">
        <span className="flex-1">{hunk.header}</span>
        <Button variant="quiet" className="!px-2 !py-0.5 !text-[11px]" onClick={() => onAddToChat(hunkText(file, hunk))} title="Attach this hunk to the chat">Add to chat</Button>
        <Button variant="quiet" className="!px-2 !py-0.5 !text-[11px]" disabledReason={STAGE_HUNK_REASON}>Stage hunk</Button>
      </div>
      {layout === "combined"
        ? hunk.lines.map((l, i) => <CombinedLine key={i} l={l} />)
        : <div className="min-w-max">{pairHunk(hunk).map((r, i) => (
          <div key={i} className="flex">
            <SplitCell l={r.left} side="left" /><div className="w-px shrink-0 bg-[var(--v2-edge)]" /><SplitCell l={r.right} side="right" />
          </div>
        ))}</div>}
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

export function DiffView({ files, layout, onLayout, onAddToChat, onOpenFile }: {
  files: DiffFile[]; layout: DiffLayout; onLayout: (l: DiffLayout) => void; onAddToChat: (text: string) => void; onOpenFile?: (path: string) => void;
}) {
  if (files.length === 0) return <div className="px-4 py-6 text-[12.5px] text-[var(--v2-muted)]">No diff for this selection.</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-diff-scroll>
      {files.map(file => (
        <section key={file.path} aria-label={`Diff of ${file.path}`} className="flex flex-col">
          <FileHeader file={file} layout={layout} onLayout={onLayout} onOpenFile={onOpenFile} />
          {file.binary && <div className="px-4 py-3 text-[12px] text-[var(--v2-muted)]">Binary file: git shows no text diff.</div>}
          {file.hunks.map(h => <HunkBlock key={h.header} file={file} hunk={h} layout={layout} onAddToChat={onAddToChat} />)}
        </section>
      ))}
    </div>
  );
}
