// Commit metadata comes from git; GitHub is offered only when origin is a GitHub remote.
import { useEffect, useState } from "react";
import { Copy, ExternalLink, GitBranchPlus, MessageSquarePlus, Sparkles } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Card } from "../../../shared/api/client";
import { Avatar } from "../../ui/Avatar";
import { Chip, type ChipTone } from "../../ui/Chip";
import { IconButton } from "../../ui/IconButton";
import { seatLabel } from "../../ui/identity";
import { DiffPane, type ChipFile } from "./DiffPane";
import { CreateBranchDialog } from "./BranchPicker";
import { toRow, type HistoryRow, type Letter } from "./model";
import { useCommitShow, type CommitPatch, type SeatBranchDiff } from "./usePatch";
import { scopeCommitMeta, type GitCommitMeta } from "./scopeGitApi";
import type { Navigate } from "../../routes";

const DONE = new Set(["done", "archived"]);
const cardTone = (status: string): ChipTone => (DONE.has(status) ? "ok" : status === "testing" ? "warn" : "info");

type Acts = { addToChat: (text: string) => void; copy: (text: string) => void; branchRefusal: string | null };
type OpenExternal = (url: string) => Promise<void>;

function Actions({ title, sha, githubUrl, acts, project, scope, onMutated, onError, openExternal }: {
  title: string; sha: string; githubUrl: string | null; acts: Acts; project: string; scope: string | null; onMutated: () => void; onError: (message: string) => void;
  openExternal: OpenExternal;
}) {
  const [create, setCreate] = useState(false);
  return (
    <span className="relative flex shrink-0 gap-0.5">
      {githubUrl && <IconButton label="Open on GitHub" title="Open this commit on GitHub" onClick={() => { void openExternal(githubUrl).catch(cause => onError(cause instanceof Error ? cause.message : String(cause))); }}><ExternalLink size={14} aria-hidden /></IconButton>}
      <IconButton label="Explain this commit" title="Explain: a chat walks you through it" onClick={() => acts.addToChat(`Explain commit ${sha}: ${title}`)}><Sparkles size={14} aria-hidden /></IconButton>
      <IconButton label="Add this commit to the chat" title="Add to chat" onClick={() => acts.addToChat(`Commit ${sha}: ${title}`)}><MessageSquarePlus size={14} aria-hidden /></IconButton>
      <IconButton label="Create a branch here" title={acts.branchRefusal ?? `Create a branch at ${sha.slice(0, 7)}`} disabled={!!acts.branchRefusal} onClick={() => setCreate(true)}><GitBranchPlus size={14} aria-hidden /></IconButton>
      <IconButton label="Copy commit id" title="Copy the full commit id" onClick={() => acts.copy(sha)}><Copy size={14} aria-hidden /></IconButton>
      {create && <CreateBranchDialog project={project} scope={scope} sha={sha} onClose={() => setCreate(false)} onCreated={onMutated} onError={onError} />}
    </span>
  );
}

function showLetter(status: string): Letter {
  return status.startsWith("A") ? "A" : status.startsWith("D") ? "D" : status.startsWith("R") ? "R" : "M";
}

function CommitBody({ show, acts, project, scope, onOpenFile }: { show: CommitPatch; acts: Acts; project: string; scope: string | null; onOpenFile?: (path: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const chips: ChipFile[] = show.files.map(f => ({ path: f.path, letter: showLetter(f.status), plus: f.plus, minus: f.minus }));
  const current = selected && chips.some(c => c.path === selected) ? selected : chips[0]?.path ?? null;
  return <DiffPane chips={chips} selected={current} onSelect={setSelected} patch={show.state} onAddToChat={acts.addToChat} onOpenFile={onOpenFile} empty="This commit changes no file text." project={project} scope={scope} />;
}

function useMeta(project: string, scope: string | null, sha: string) {
  const [meta, setMeta] = useState<GitCommitMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setMeta(null);
    setError(null);
    scopeCommitMeta(project, scope, sha)
      .then(value => { if (alive) setMeta(value); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive = false; };
  }, [project, scope, sha]);
  return { meta, error };
}

function SingleCommit({ row, project, scope, cards, acts, onNavigate, onMutated, onError, onSelectCommit, openExternal, onOpenFile }: {
  row: HistoryRow; project: string; scope: string | null; cards: Card[]; acts: Acts; onNavigate: Navigate; onMutated: () => void; onError: (message: string) => void;
  onSelectCommit: (sha: string) => void; openExternal: OpenExternal; onOpenFile?: (path: string) => void;
}) {
  const who = row.seat ?? row.author;
  const card = row.card === null ? null : cards.find(c => c.id === row.card) ?? null;
  const show = useCommitShow(project, scope, row.sha);
  const { meta, error: metaError } = useMeta(project, scope, row.sha);
  const plus = show.files.reduce((sum, file) => sum + (file.plus ?? 0), 0);
  const minus = show.files.reduce((sum, file) => sum + (file.minus ?? 0), 0);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-[var(--v2-edge)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="m-0 min-w-0 flex-[1_1_300px] text-v2-title font-[650]">{row.subject}</h2>
          <Actions title={row.subject} sha={meta?.sha ?? row.sha} githubUrl={meta?.github_url ?? null} acts={acts} project={project} scope={scope} onMutated={onMutated} onError={onError} openExternal={openExternal} />
        </div>
        <div className="flex flex-wrap items-center gap-2.5 text-v2-body text-[var(--v2-muted)]">
          <span className="inline-flex items-center gap-1.5"><Avatar name={who} size={20} /><span className="text-[var(--v2-text-2)]">{seatLabel(who)}</span>{row.seat && row.author !== row.seat && <span>({row.author})</span>}</span>
          <span>{row.when}</span>
          <span className="v2-mono">{row.sha}</span>
          {meta && meta.parents.length > 0 && <span>{meta.parents.length === 1 ? "Parent" : "Parents"}: {meta.parents.map(parent => (
            <button key={parent} type="button" title={`Open parent ${parent}`} onClick={() => onSelectCommit(parent)} className="v2-mono ml-1 border-0 bg-transparent p-0 text-[var(--v2-accent)] underline">{parent.slice(0, 8)}</button>
          ))}</span>}
          {show.state.kind === "ok" && <span>{show.files.length} {show.files.length === 1 ? "file" : "files"} changed · <span className="text-[var(--v2-ok)]">+{plus}</span> <span className="text-[var(--v2-bad)]">−{minus}</span></span>}
        </div>
        {meta && <pre className="m-0 whitespace-pre-wrap break-words font-[inherit] text-v2-base leading-5 text-[var(--v2-text-2)]">{meta.message}</pre>}
        {metaError && <div role="alert" className="text-v2-body text-[var(--v2-bad)]">{metaError}</div>}
        {row.card !== null && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => onNavigate("board")} title="Open the board" className="border-0 bg-transparent p-0">
              <Chip tone={card ? cardTone(card.status) : "neutral"} mono>#{row.card}{card ? ` ${card.title} · ${card.status}` : ""}</Chip>
            </button>
          </div>
        )}
      </div>
      <CommitBody key={row.sha} show={show} acts={acts} project={project} scope={scope} onOpenFile={onOpenFile} />
    </div>
  );
}

export function UnlandedDetail({ branch, count, diff, acts, project, scope, onOpenFile }: { branch: string | null; count: number; diff: SeatBranchDiff; acts: Acts; project: string; scope: string | null; onOpenFile?: (path: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const chips: ChipFile[] = diff.files.map(f => ({ path: f.path, letter: f.untracked ? "U" : "M", plus: f.plus, minus: f.minus }));
  const current = selected ?? chips[0]?.path ?? null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--v2-edge)] px-4 py-3">
        <h2 className="m-0 min-w-0 flex-[1_1_300px] text-v2-title font-[650]">{count} {count === 1 ? "commit" : "commits"} on {branch ?? "this branch"} not on the default branch</h2>
        <Chip mono title="Merge base with the default branch">{diff.base ? diff.base.slice(0, 7) : "base unknown"}</Chip>
      </div>
      <DiffPane chips={chips} selected={current} onSelect={setSelected} patch={diff.state} onAddToChat={acts.addToChat} onOpenFile={onOpenFile} empty="No file changes against the default branch." project={project} scope={scope} />
    </div>
  );
}

function CommitFromSha({ sha, project, scope, cards, acts, onNavigate, onMutated, onError, onSelectCommit, openExternal, onOpenFile }: {
  sha: string; project: string; scope: string | null; cards: Card[]; acts: Acts; onNavigate: Navigate;
  onMutated: () => void; onError: (message: string) => void; onSelectCommit: (sha: string) => void; openExternal: OpenExternal; onOpenFile?: (path: string) => void;
}) {
  const { meta, error } = useMeta(project, scope, sha);
  if (error) return <div role="alert" className="px-4 py-6 text-v2-base text-[var(--v2-bad)]">{error}</div>;
  if (!meta) return <div className="px-4 py-6 text-v2-base text-[var(--v2-muted)]">Reading {sha.slice(0, 8)}</div>;
  const row = toRow(meta, { seats: [], branch: null });
  return <SingleCommit row={row} project={project} scope={scope} cards={cards} acts={acts} onNavigate={onNavigate} onMutated={onMutated} onError={onError} onSelectCommit={onSelectCommit} openExternal={openExternal} onOpenFile={onOpenFile} />;
}

export function CommitDetail({ row, selectedSha, project, scope, cards, acts, onNavigate, onMutated, onError, onSelectCommit, openExternal = openUrl, onOpenFile }: {
  row: HistoryRow | null; selectedSha?: string | null; project: string; scope: string | null; cards: Card[]; acts: Acts; onNavigate: Navigate;
  onMutated: () => void; onError: (message: string) => void; onSelectCommit: (sha: string) => void; openExternal?: OpenExternal; onOpenFile?: (path: string) => void;
}) {
  if (row) return <SingleCommit row={row} project={project} scope={scope} cards={cards} acts={acts} onNavigate={onNavigate} onMutated={onMutated} onError={onError} onSelectCommit={onSelectCommit} openExternal={openExternal} onOpenFile={onOpenFile} />;
  if (selectedSha) return <CommitFromSha sha={selectedSha} project={project} scope={scope} cards={cards} acts={acts} onNavigate={onNavigate} onMutated={onMutated} onError={onError} onSelectCommit={onSelectCommit} openExternal={openExternal} onOpenFile={onOpenFile} />;
  return <div className="flex flex-1 items-center justify-center px-6 text-v2-base text-[var(--v2-muted)]">Pick a commit to read it.</div>;
}
