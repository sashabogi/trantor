// Commit detail (#13988): title, the seven icon actions, author line, card evidence, and the diff.
// A single commit's files and patch come from git_show on either checkout (#13988 drill); the seat's
// unlanded work against main is the seat_diff patch.
import { useState } from "react";
import { Copy, ExternalLink, GitBranchPlus, MessageSquarePlus, MoreHorizontal, ScanSearch, Sparkles, Users } from "lucide-react";
import type { Card } from "../../../shared/api/client";
import { Avatar } from "../../ui/Avatar";
import { Chip, type ChipTone } from "../../ui/Chip";
import { IconButton } from "../../ui/IconButton";
import { seatLabel } from "../../ui/identity";
import { MenuItem, Popover } from "../../shell/Popover";
import { DiffPane, type ChipFile } from "./DiffPane";
import type { HistoryRow, Letter } from "./model";
import { useCommitShow, type CommitPatch, type SeatBranchDiff } from "./usePatch";
import type { Navigate } from "../../routes";

const DONE = new Set(["done", "archived"]);
const cardTone = (status: string): ChipTone => (DONE.has(status) ? "ok" : status === "testing" ? "warn" : "info");

type Acts = { addToChat: (text: string) => void; copy: (text: string) => void };

function Actions({ title, sha, acts }: { title: string; sha: string; acts: Acts }) {
  const [more, setMore] = useState(false);
  return (
    <span className="relative flex shrink-0 gap-0.5">
      <IconButton label="Open on GitHub" title="Open on GitHub needs the remote URL, which no command reads yet." disabled><ExternalLink size={14} aria-hidden /></IconButton>
      <IconButton label="Explain this commit" title="Explain: a chat walks you through it" onClick={() => acts.addToChat(`Explain commit ${sha}: ${title}`)}><Sparkles size={14} aria-hidden /></IconButton>
      <IconButton label="Add this commit to the chat" title="Add to chat" onClick={() => acts.addToChat(`Commit ${sha}: ${title}`)}><MessageSquarePlus size={14} aria-hidden /></IconButton>
      <IconButton label="Crew review this commit" title="Crew review: two other seats review it, read-only. No start command from the desktop yet." disabled><Users size={14} aria-hidden /></IconButton>
      <IconButton label="Review this commit and every later one" title="Review through latest needs the crew review command. Not wired yet." disabled><ScanSearch size={14} aria-hidden /></IconButton>
      <IconButton label="Create a branch here" title="Branch from here needs a git branch command. Not wired yet." disabled><GitBranchPlus size={14} aria-hidden /></IconButton>
      <IconButton label="Revert, copy id, cherry-pick" title="More: copy id, revert, cherry-pick" onClick={() => setMore(m => !m)}><MoreHorizontal size={14} aria-hidden /></IconButton>
      <Popover open={more} onClose={() => setMore(false)} label="Commit actions" align="right">
        <MenuItem onSelect={() => { acts.copy(sha); setMore(false); }}><Copy size={12} aria-hidden />Copy id</MenuItem>
        <MenuItem onSelect={() => setMore(false)} title="Revert needs a git revert command. Not wired yet."><span className="opacity-50">Revert (not wired)</span></MenuItem>
        <MenuItem onSelect={() => setMore(false)} title="Cherry-pick needs a git cherry-pick command. Not wired yet."><span className="opacity-50">Cherry-pick (not wired)</span></MenuItem>
      </Popover>
    </span>
  );
}

function showLetter(status: string): Letter {
  return status.startsWith("A") ? "A" : status.startsWith("D") ? "D" : status.startsWith("R") ? "R" : "M";
}

function CommitBody({ show, acts }: { show: CommitPatch; acts: Acts }) {
  const [selected, setSelected] = useState<string | null>(null);
  const chips: ChipFile[] = show.files.map(f => ({ path: f.path, letter: showLetter(f.status), plus: f.plus, minus: f.minus }));
  const current = selected && chips.some(c => c.path === selected) ? selected : chips[0]?.path ?? null;
  return <DiffPane chips={chips} selected={current} onSelect={setSelected} patch={show.state} onAddToChat={acts.addToChat} empty="This commit changes no file text." />;
}

function SingleCommit({ row, project, scope, cards, acts, onNavigate }: { row: HistoryRow; project: string; scope: string | null; cards: Card[]; acts: Acts; onNavigate: Navigate }) {
  const who = row.seat ?? row.author;
  const card = row.card === null ? null : cards.find(c => c.id === row.card) ?? null;
  const show = useCommitShow(project, scope, row.sha);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-[var(--v2-edge)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="m-0 min-w-0 flex-[1_1_300px] text-[16px] font-[650]">{row.subject}</h2>
          <Actions title={row.subject} sha={row.sha} acts={acts} />
        </div>
        <div className="flex flex-wrap items-center gap-2.5 text-[12px] text-[var(--v2-muted)]">
          <span className="inline-flex items-center gap-1.5"><Avatar name={who} size={20} /><span className="text-[var(--v2-text-2)]">{seatLabel(who)}</span>{row.seat && row.author !== row.seat && <span>({row.author})</span>}</span>
          <span>{row.when}</span>
          <span className="v2-mono">{row.sha}</span>
        </div>
        {row.card !== null && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => onNavigate("board")} title="Open the board" className="border-0 bg-transparent p-0">
              <Chip tone={card ? cardTone(card.status) : "neutral"} mono>#{row.card}{card ? ` ${card.title} · ${card.status}` : ""}</Chip>
            </button>
          </div>
        )}
      </div>
      <CommitBody key={row.sha} show={show} acts={acts} />
    </div>
  );
}

export function UnlandedDetail({ branch, count, diff, acts }: { branch: string | null; count: number; diff: SeatBranchDiff; acts: Acts }) {
  const [selected, setSelected] = useState<string | null>(null);
  const chips: ChipFile[] = diff.files.map(f => ({ path: f.path, letter: f.untracked ? "U" : "M", plus: f.plus, minus: f.minus }));
  const current = selected ?? chips[0]?.path ?? null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--v2-edge)] px-4 py-3">
        <h2 className="m-0 min-w-0 flex-[1_1_300px] text-[16px] font-[650]">{count} {count === 1 ? "commit" : "commits"} on {branch ?? "this branch"} not on main</h2>
        <Chip mono title="Merge base with main">{diff.base ? diff.base.slice(0, 7) : "base unknown"}</Chip>
      </div>
      <DiffPane chips={chips} selected={current} onSelect={setSelected} patch={diff.state} onAddToChat={acts.addToChat} empty="No file changes against main." />
    </div>
  );
}

export function CommitDetail({ row, project, scope, cards, acts, onNavigate }: {
  row: HistoryRow | null; project: string; scope: string | null; cards: Card[]; acts: Acts; onNavigate: Navigate;
}) {
  if (!row) return <div className="flex flex-1 items-center justify-center px-6 text-[12.5px] text-[var(--v2-muted)]">Pick a commit to read it.</div>;
  return <SingleCommit row={row} project={project} scope={scope} cards={cards} acts={acts} onNavigate={onNavigate} />;
}
