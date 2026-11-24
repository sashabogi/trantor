import { useEffect, useMemo, useState } from "react";
import type { ScreenProps } from "../../index";
import { useTasks } from "../../../shared/tasks";
import { hasSeen, markSeen, onSeenChange } from "../../../shared/seen";
import { useInboxData } from "./useInboxData";
import { itemMatches, makeInboxItems, searchInboxItems, type InboxFilter, type InboxItem, type InboxSort, type MessageItem } from "./model";
import { InboxFilters } from "./Filters";
import { InboxList } from "./InboxList";
import { EmptyInboxDetail, InboxDetail } from "./Detail";

const NEXT_SORT = { ranked: "newest", newest: "project", project: "ranked" } satisfies Record<InboxSort, InboxSort>;

export function InboxScreen({ client, onNavigate }: ScreenProps) {
  const data = useInboxData(client);
  const cards = useTasks(client);
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<InboxFilter>("needs");
  const [project, setProject] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<InboxSort>("ranked");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [, setSeenVersion] = useState(0);

  useEffect(() => onSeenChange(() => setSeenVersion(version => version + 1)), []);
  const items = useMemo(() => makeInboxItems({
    messages: data.messages, proposals: data.proposals, holds: data.holds, peers: data.peers, cards,
  }), [data.messages, data.proposals, data.holds, data.peers, cards]);
  const visible = useMemo(() => searchInboxItems(
    items.filter(item => itemMatches(item, filter, settled)), search, project,
  ), [items, filter, settled, search, project]);
  const selected = visible.find(item => item.key === selectedKey) ?? null;

  useEffect(() => {
    if (selected || (selectedKey && visible.some(item => item.key === selectedKey))) return;
    setSelectedKey(visible[0]?.key ?? null);
  }, [selected, selectedKey, visible]);
  useEffect(() => {
    if (selected?.kind !== "question" || hasSeen(selected.message.id)) return;
    markSeen(selected.message.id);
    void client.delivered(selected.message.id);
  }, [client, selected]);

  const settle = (item: InboxItem) => setSettled(current => new Set(current).add(item.key));
  const clearStale = (stale: MessageItem[]) => {
    for (const item of stale) {
      markSeen(item.message.id);
      void client.delivered(item.message.id);
    }
    setSettled(current => {
      const next = new Set(current);
      for (const item of stale) next.add(item.key);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-[620px] flex-col">
      {data.error && <p role="alert" className="m-0 border-b border-[var(--v2-edge)] px-3 py-1.5 text-[12px] text-[var(--v2-bad)]">{data.error}</p>}
      <div className="flex min-h-0 flex-1">
        <InboxFilters items={items} settled={settled} filter={filter} project={project}
          onFilter={next => { setFilter(next); setProject(""); }} onProject={setProject}
          onMessages={() => onNavigate("messages")} />
        <InboxList items={visible} filter={filter} selected={selectedKey} search={search} sort={sort}
          onSearch={setSearch} onSort={() => setSort(NEXT_SORT[sort])} onSelect={setSelectedKey} onClearStale={clearStale} />
        {selected ? (
          <InboxDetail key={selected.key} client={client} item={selected} cards={cards} peers={data.peers}
            onSettled={settle} onOpenConversation={() => onNavigate("messages")}
            onOpenCard={() => onNavigate("board", selected.project || undefined)} />
        ) : <EmptyInboxDetail />}
      </div>
      {!data.loaded && <span role="status" className="absolute top-2 right-2 text-[11px] text-[var(--v2-muted)]">Reading your inbox…</span>}
    </div>
  );
}
