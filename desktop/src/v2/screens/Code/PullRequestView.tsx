// The pull request view (#13988). No command opens or reads a PR yet, so there is no number and no
// checks list. What it shows is real: the seat branch against main, its commits and its files.
import { useState } from "react";
import { ExternalLink, GitMerge, MessageSquarePlus } from "lucide-react";
import type { Card } from "../../../shared/api/client";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { seatLabel } from "../../ui/identity";
import { DiffPane, type ChipFile } from "./DiffPane";
import { NotWiredBlock } from "./parts";
import { parseCardRef } from "./model";
import type { SeatBranchDiff } from "./usePatch";
import type { ScopeSnapshot } from "./useScopeGit";

type PrTab = "checks" | "conversation" | "commits" | "files";
const TABS: { id: PrTab; label: string }[] = [
  { id: "checks", label: "Checks" }, { id: "conversation", label: "Conversation" }, { id: "commits", label: "Commits" }, { id: "files", label: "Files" },
];

function Commits({ snap }: { snap: ScopeSnapshot }) {
  const rows = snap.log.slice(0, snap.ahead ?? 0);
  if (rows.length === 0) return <div className="p-4 text-[12.5px] text-[var(--v2-muted)]">No commits ahead of main.</div>;
  return (
    <ul className="m-0 list-none p-0">
      {rows.map(c => (
        <li key={c.sha} className="flex items-baseline gap-3 border-b border-[var(--v2-edge)] px-4 py-2 text-[12.5px]">
          <span className="v2-mono shrink-0 text-[11px] text-[var(--v2-accent)]">{c.sha}</span>
          <span className="min-w-0 flex-1 truncate">{c.subject}</span>
          {parseCardRef(c.subject) !== null && <span className="v2-mono text-[11px] text-[var(--v2-muted)]">#{parseCardRef(c.subject)}</span>}
          <span className="shrink-0 text-[11px] text-[var(--v2-muted)]">{c.when}</span>
        </li>
      ))}
    </ul>
  );
}

function totals(diff: SeatBranchDiff): { plus: number; minus: number } {
  return diff.files.reduce((acc, f) => ({ plus: acc.plus + (f.plus ?? 0), minus: acc.minus + (f.minus ?? 0) }), { plus: 0, minus: 0 });
}

export function PullRequestView({ seat, snap, diff, cards, onAddToChat }: {
  seat: string; snap: ScopeSnapshot; diff: SeatBranchDiff; cards: Card[]; onAddToChat: (text: string) => void;
}) {
  const [tab, setTab] = useState<PrTab>("files");
  const [selected, setSelected] = useState<string | null>(null);
  const branch = snap.branch ?? `seat/${seat}`;
  const ahead = snap.ahead ?? 0;
  const t = totals(diff);
  const chips: ChipFile[] = diff.files.map(f => ({ path: f.path, letter: f.untracked ? "U" : "M", plus: f.plus, minus: f.minus }));
  const seatCards = cards.filter(c => c.assignee?.startsWith(`${seat}:`) && c.status !== "done");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-[var(--v2-edge)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Chip tone="neutral">No pull request</Chip>
          <h2 className="m-0 min-w-0 flex-[1_1_300px] text-[16px] font-[650]">{branch} into main</h2>
          <Button icon={<ExternalLink size={13} aria-hidden />} disabledReason="Open on GitHub needs the remote URL and a gh command. Not wired yet.">Open on GitHub</Button>
          <Button icon={<MessageSquarePlus size={13} aria-hidden />} onClick={() => onAddToChat(`Branch ${branch}: ${ahead} commits ahead of main, ${diff.files.length} files, +${t.plus} -${t.minus}`)}>Add to chat</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--v2-muted)]">
          <Avatar name={seat} size={18} /><span className="text-[var(--v2-text-2)]">{seatLabel(seat)}</span>
          <span>has {ahead} {ahead === 1 ? "commit" : "commits"} from <span className="v2-mono text-[var(--v2-text-2)]">{branch}</span> not on main</span>
          <span className="v2-mono text-[var(--v2-ok)]">+{t.plus}</span><span className="v2-mono text-[var(--v2-bad)]">−{t.minus}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" icon={<GitMerge size={13} aria-hidden />} disabledReason="No merge command yet, and no pull request exists to merge.">Merge</Button>
          <span className="text-[11.5px] text-[var(--v2-muted)]">A merge waits for the drill on the card, not only for green checks.</span>
        </div>
      </div>
      <div role="tablist" aria-label="Pull request sections" className="flex gap-0.5 border-b border-[var(--v2-edge)] px-3">
        {TABS.map(x => (
          <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)}
            className={`border-0 border-b-2 bg-transparent px-3 py-2 text-[12.5px] ${tab === x.id ? "border-[var(--v2-accent)] text-[var(--v2-text)]" : "border-transparent text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}>
            {x.label}{x.id === "commits" && ` ${ahead}`}{x.id === "files" && ` ${diff.files.length}`}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === "checks" && <div className="p-4"><NotWiredBlock title="Checks are not readable yet" line="CI results need the GitHub API through gh, and no desktop command runs it. No check names or timings are shown rather than invented ones." /></div>}
        {tab === "conversation" && <div className="p-4"><NotWiredBlock title="Conversation is not readable yet" line="Review comments live on the pull request, and there is no pull request command yet." /></div>}
        {tab === "commits" && <Commits snap={snap} />}
        {tab === "files" && <DiffPane chips={chips} selected={selected ?? chips[0]?.path ?? null} onSelect={setSelected} patch={diff.state} onAddToChat={onAddToChat} empty="No file changes against main." />}
      </div>
      {seatCards.length > 0 && <div className="border-t border-[var(--v2-edge)] px-4 py-2 text-[11.5px] text-[var(--v2-muted)]">Cards on this seat: {seatCards.map(c => `#${c.id} ${c.status}`).join(" · ")}</div>}
    </div>
  );
}
