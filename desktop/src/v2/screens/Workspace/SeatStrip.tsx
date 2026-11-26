// The seat strip: one tab per live seat, +N offline, add seat, the layout switch and Record (#13987).
// #14241: seats read as tabs joined to the workspace pane below, not pills.
// #14365: a crew seat tab is just its compact astronaut; the name and what it is doing live in the aria-label, the hover card and the seat bar.
import { useEffect, useState, type ReactNode } from "react";
import { Columns2, Ellipsis, Grid2x2, ListChecks, Plus, Square } from "lucide-react";
import type { Card } from "../../../shared/api/client";
import { ago } from "../../../shared/time";
import { activityLine, seatState } from "../../ui/identity";
import { SeatAstronaut } from "../../ui/SeatAstronaut";
import { Tabs, type TabSpec } from "../../ui/Tabs";
import { ActionMenu } from "./ActionMenu";
import { AgentDot } from "./AgentDot";
import { PopMenu } from "./PopMenu";
import { SeatHoverCard } from "./SeatHoverCard";
import { SeatMark } from "./SeatMark";
import { isCollapsedAgent, liveSeats, offlineNote, offlineSeats, type Layout, type SeatView } from "./seatModel";
import type { Crew } from "./useCrew";
import { cardOf, type MayDo } from "./useWorkspaceData";

const LAYOUTS: readonly { value: Layout; title: string; icon: ReactNode }[] = [
  { value: "focus", title: "Focus: one seat", icon: <Square size={12} aria-hidden /> },
  { value: "split", title: "Split: two seats side by side", icon: <Columns2 size={12} aria-hidden /> },
  { value: "grid", title: "Grid: every seat", icon: <Grid2x2 size={12} aria-hidden /> },
];

/** More tabs than this and the inactive labelled tabs (helpers, agents) shrink to a shared width; icon tabs never shrink. */
export const CROWDED_TABS = 6;

const TICK_MS = 30_000;
const TAB_LABEL_CHARS = 28;

/** #14265: a clock for the 10 minute fold of finished sub-agents; it ticks only while some agent has finished. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(iv);
  }, [active]);
  return now;
}

const shortLabel = (s: SeatView) => (s.agentInfo && s.label.length > TAB_LABEL_CHARS ? `${s.label.slice(0, TAB_LABEL_CHARS - 1)}…` : s.label);

export function SeatStrip({ project, seats, selectedKey, onSelect, layout, onLayout, crew, onDrill, cards, mayDo, needs }: {
  project: string; seats: SeatView[]; selectedKey: string | undefined; onSelect: (key: string) => void;
  layout: Layout; onLayout: (l: Layout) => void; crew: Crew; onDrill: () => void;
  cards: Card[]; mayDo: MayDo;
  /** What each seat is waiting on you for, by seat key: "approve edit a.ts". */
  needs: Record<string, string>;
}) {
  const offline = offlineSeats(seats);
  const now = useNow(seats.some(s => s.agentInfo?.state === "done"));
  const folded = liveSeats(seats).filter(s => isCollapsedAgent(s, now, selectedKey));
  const shown = liveSeats(seats).filter(s => !folded.includes(s));
  const quiet = "shrink-0 whitespace-nowrap rounded-md border-0 bg-transparent px-2 py-1 text-v2-small text-[var(--v2-muted)] hover:bg-[var(--v2-row-hover)] hover:text-[var(--v2-text)]";
  const tabs: TabSpec[] = [...shown.filter(s => !s.isHelper && !s.agentInfo), ...shown.filter(s => s.isHelper), ...shown.filter(s => s.agentInfo)].map(s => {
    const line = activityLine(s, { needs: needs[s.key] });
    const iconOnly = !s.isHelper && !s.agentInfo;
    const hover = s.agentInfo ? undefined : <SeatHoverCard project={project} seat={s} card={cardOf(cards, s)} mayDo={mayDo} />;
    if (iconOnly) {
      return {
        id: s.key, label: s.label, title: s.session, iconOnly, ariaLabel: `${s.label}, ${line}`,
        leading: <SeatAstronaut vendor={s.brand} name={s.label} state={seatState(s)} size={64} variant="full" surface={s.key === selectedKey ? "var(--v2-bg)" : "var(--v2-chrome)"} />,
        hoverCard: hover,
      };
    }
    return {
      id: s.key,
      label: shortLabel(s),
      title: s.agentInfo ? s.label : s.session,
      close: s.isHelper && !crew.busy,
      closeLabel: s.isHelper ? `Stop ${s.label}` : undefined,
      leading: s.agentInfo ? <AgentDot running={s.agentInfo.state === "running"} /> : <SeatMark seat={s} ring="var(--v2-chrome)" />,
      line2: <span style={{ color: s.presence === "needs-you" ? "var(--v2-warn)" : undefined }}>{line}</span>,
      sub: s.isHelper || s.agentInfo ? <span className="rounded-sm bg-[var(--v2-sunken)] px-1 text-v2-micro text-[var(--v2-muted)]">{s.agentInfo ? "agent" : "helper"}</span> : undefined,
      hoverCard: hover,
    };
  });
  return (
    <Tabs label="Seats" pane="var(--v2-bg)" barClassName="h-22 px-3" tabs={tabs} activeId={selectedKey} onSelect={onSelect}
      stacked crowded={tabs.length > CROWDED_TABS}
      onClose={key => { const helper = seats.find(s => s.key === key && s.isHelper); if (helper) void crew.stopHelper(helper.agent.slice("helper:".length)); }}
      actions={<>
        {folded.length > 0 && (
          <PopMenu heading="Finished agents" empty="No finished agents"
            items={folded.map(s => ({ id: s.key, label: s.label, sub: s.agentInfo ? `finished ${ago(s.agentInfo.lastActivityMs)}` : undefined, onPick: () => onSelect(s.key) }))}
            trigger={(p, open) => (
              <button type="button" {...p} title={folded.map(s => s.label).join("\n")} className={quiet} data-open={open || undefined}>+{folded.length} finished</button>
            )} />
        )}
        {offline.length > 0 && (
          <PopMenu heading="Offline seats" empty="No offline seats"
            items={offline.map(s => ({ id: s.key, label: `Start ${s.label}`, sub: offlineNote(s), disabledReason: crew.busy ? "Another seat action is running" : null, onPick: () => void crew.start(s.agent) }))}
            trigger={(p, open) => (
              <button type="button" {...p} title={offline.map(s => `${s.label}, ${offlineNote(s)}`).join("\n")} className={quiet} data-open={open || undefined}>+{offline.length} offline</button>
            )} />
        )}
        <PopMenu heading="Add a seat" empty={crew.unavailableReason?.() ?? "Reading installed agents"}
          items={crew.available.map(a => ({ id: a.id, label: a.label, sub: `starts ${a.launch}`, disabledReason: crew.busy ? "Another seat action is running" : null, onPick: () => void crew.start(a.id) }))}
          trigger={p => (
            <button type="button" {...p} aria-label="Add a seat" title="Add a seat"
              className="v2-hover inline-flex size-[26px] shrink-0 items-center justify-center rounded-full border border-[var(--v2-edge-2)] bg-transparent text-[var(--v2-muted)]">
              <Plus size={13} strokeWidth={2.2} aria-hidden />
            </button>
          )} />
      </>}
      end={<>
        <div role="group" aria-label="Layout" className="flex shrink-0 gap-px rounded-md border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] p-px">
          {LAYOUTS.map(o => (
            <button key={o.value} type="button" aria-pressed={o.value === layout} aria-label={o.title.split(":")[0]} title={o.title} onClick={() => onLayout(o.value)}
              className={`inline-flex size-6 items-center justify-center rounded-sm border-0 transition-colors ${o.value === layout ? "bg-[var(--v2-hover)] text-[var(--v2-text)]" : "bg-transparent text-[var(--v2-muted)] hover:text-[var(--v2-text)]"}`}
              style={{ transitionDuration: "var(--v2-dur-2)" }}>{o.icon}</button>
          ))}
        </div>
        <ActionMenu label="Strip actions"
          items={[
            { id: "drill", label: "Drill mode", icon: <ListChecks size={13} aria-hidden />, onPick: onDrill },
            { id: "all", label: "All seats", sub: { heading: "All seats", empty: "No seats yet",
              items: seats.map(s => ({ id: s.key, label: s.label, onPick: () => onSelect(s.key) })) } },
          ]}
          trigger={p => (
            <button type="button" {...p} aria-label="More strip actions" title="More"
              className="v2-hover inline-flex size-6 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-[var(--v2-muted)]">
              <Ellipsis size={14} aria-hidden />
            </button>
          )} />
      </>} />
  );
}
