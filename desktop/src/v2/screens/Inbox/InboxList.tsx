import { CircleHelp, ListOrdered, Search, Shield, TriangleAlert } from "lucide-react";
import { Avatar, Button, ProjectTile, seatLabel } from "../../index";
import { hasSeen } from "../../../shared/seen";
import { ago } from "../../../shared/time";
import { rankInboxItems, splitStaleItems, type InboxFilter, type InboxItem, type InboxSort, type MessageItem } from "./model";

const KIND = {
  question: { label: "Question", color: "var(--v2-accent)", icon: CircleHelp },
  collision: { label: "Collision", color: "var(--v2-bad)", icon: TriangleAlert },
  proposal: { label: "Proposal", color: "#CDB1FF", icon: Shield },
} as const;

function KindLabel({ kind }: { kind: InboxItem["kind"] }) {
  const meta = KIND[kind];
  const Icon = meta.icon;
  return <span className="inline-flex items-center gap-1" style={{ color: meta.color }}><Icon size={11} aria-hidden />{meta.label}</span>;
}

function InboxRow({ item, selected, onSelect }: { item: InboxItem; selected: boolean; onSelect: (key: string) => void }) {
  const unread = item.kind === "question" && !hasSeen(item.message.id);
  return (
    <button type="button" data-inbox-key={item.key} aria-pressed={selected} onClick={() => onSelect(item.key)}
      className={`flex w-full gap-2.5 border-0 border-b border-[var(--v2-edge)] px-3.5 py-[11px] text-left ${
        selected ? "bg-[var(--v2-raised)] shadow-[inset_2px_0_0_var(--v2-accent)]" : "bg-transparent"}`}>
      <span className="relative shrink-0">
        <Avatar name={item.from} size={30} />
        {item.project && <span className="absolute -right-1 -bottom-1"><ProjectTile name={item.project} size={15} /></span>}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--v2-muted)]">
          <KindLabel kind={item.kind} />·<span className="truncate font-semibold text-[var(--v2-text)]">{seatLabel(item.from)}</span>
          {item.project && <>· {item.project}</>}<span className="flex-1" />
          <span className="shrink-0">{ago(item.ts).replace(" ago", "")}</span>
          {unread && <span aria-label="Unread" className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--v2-accent)]" />}
        </span>
        <span className={`line-clamp-2 text-[13px] leading-[1.35] ${unread ? "font-semibold" : "font-normal"}`}>{item.title}</span>
        <span className="truncate text-[11.5px] text-[var(--v2-warn)]">{item.unblockLabel}</span>
      </span>
    </button>
  );
}

function StaleRow({ item, selected, onSelect }: { item: MessageItem; selected: boolean; onSelect: (key: string) => void }) {
  return (
    <button type="button" data-inbox-key={item.key} onClick={() => onSelect(item.key)}
      className={`flex w-full items-center gap-2.5 border-0 border-b border-[var(--v2-edge)] px-3.5 py-2 text-left opacity-70 ${selected ? "bg-[var(--v2-raised)]" : "bg-transparent"}`}>
      <Avatar name={item.from} size={22} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px]">{item.title}</span>
        <span className="text-[11px] text-[var(--v2-muted)]">{item.stale.stale ? item.stale.reason : ""}</span>
      </span>
      {item.project && <ProjectTile name={item.project} size={14} />}
    </button>
  );
}

export function InboxList({ items, filter, selected, search, sort, onSearch, onSort, onSelect, onClearStale }: {
  items: InboxItem[];
  filter: InboxFilter;
  selected: string | null;
  search: string;
  sort: InboxSort;
  onSearch: (search: string) => void;
  onSort: () => void;
  onSelect: (key: string) => void;
  onClearStale: (items: MessageItem[]) => void;
}) {
  const groups = splitStaleItems(items);
  const live = rankInboxItems(filter === "answered" ? items : groups.live, sort);
  const stale = rankInboxItems(filter === "answered" ? [] : groups.stale, sort);
  const sortLabel = sort === "ranked" ? "Ranked" : sort === "newest" ? "Newest" : "By project";
  return (
    <section aria-label="Needs you" className="flex w-[470px] shrink-0 flex-col border-r border-[var(--v2-edge)]">
      <div className="flex items-center gap-2 border-b border-[var(--v2-edge)] px-3.5 py-3">
        <label htmlFor="v2-inbox-search" className="sr-only">Search the inbox</label>
        <div className="flex flex-1 items-center gap-1.5 rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] px-2.5 text-[var(--v2-muted)]">
          <Search size={12} aria-hidden />
          <input id="v2-inbox-search" value={search} onChange={event => onSearch(event.target.value)}
            placeholder="Search: text, @seat, #card, project:" className="min-w-0 flex-1 border-0 bg-transparent py-1.5 text-[12px] text-[var(--v2-text)] outline-none" />
        </div>
        <Button icon={<ListOrdered size={12} aria-hidden />} title="Ranked by what each one unblocks; or Newest, or By project" onClick={onSort}>{sortLabel}</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sort === "ranked" && live.length > 0 && <div className="px-3.5 pt-2 pb-1.5 text-[11px] text-[var(--v2-muted)]">Ranked by what an answer unblocks</div>}
        {live.map(item => <InboxRow key={item.key} item={item} selected={selected === item.key} onSelect={onSelect} />)}
        {stale.length > 0 && (
          <>
            <div className="flex items-center gap-2 px-3.5 pt-3 pb-1.5">
              <span className="flex-1 text-[10.5px] font-semibold tracking-[0.08em] text-[var(--v2-muted)]">STALE · SAFE TO CLEAR</span>
              <Button title="Each one says why it is stale; nothing is deleted, they move to Answered" onClick={() => onClearStale(stale)}>Clear {stale.length}</Button>
            </div>
            {stale.map(item => <StaleRow key={item.key} item={item} selected={selected === item.key} onSelect={onSelect} />)}
          </>
        )}
        {!items.length && (
          <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-1 p-8 text-center">
            <span className="text-[13px]">Nothing waiting on you.</span>
            <span className="text-[12px] text-[var(--v2-muted)]">Agent-to-agent traffic lives in each project's conversation.</span>
          </div>
        )}
      </div>
    </section>
  );
}
