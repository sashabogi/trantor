// The seat strip: one tab per live seat, +N offline, add seat, the layout switch and Record (#13987).
// #14241: seats read as tabs joined to the workspace pane below, not pills.
import { useEffect, useState } from "react";
import { Columns2, Grid2x2, Plus, Square } from "lucide-react";
import { ago } from "../../../shared/time";
import { Avatar } from "../../ui/Avatar";
import { PRESENCE_COLOR } from "../../ui/identity";
import { Seg, type SegOption } from "../../ui/Seg";
import { Tabs, type TabSpec } from "../../ui/Tabs";
import { AgentDot } from "./AgentDot";
import { PopMenu } from "./PopMenu";
import { isCollapsedAgent, liveCrewSeats, liveSeats, offlineNote, offlineSeats, type Layout, type SeatView } from "./seatModel";
import type { Crew } from "./useCrew";

const LAYOUTS: readonly SegOption<Layout>[] = [
  { value: "focus", label: "Focus", title: "Focus: one seat", icon: <Square size={12} aria-hidden /> },
  { value: "split", label: "Split", title: "Split: two seats side by side", icon: <Columns2 size={12} aria-hidden /> },
  { value: "grid", label: "Grid", title: "Grid: every seat", icon: <Grid2x2 size={12} aria-hidden /> },
];

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

export function SeatStrip({ seats, selectedKey, onSelect, layout, onLayout, crew, recording, onRecord }: {
  seats: SeatView[]; selectedKey: string | undefined; onSelect: (key: string) => void;
  layout: Layout; onLayout: (l: Layout) => void; crew: Crew; recording: boolean; onRecord: () => void;
}) {
  const offline = offlineSeats(seats);
  const now = useNow(seats.some(s => s.agentInfo?.state === "done"));
  const folded = liveSeats(seats).filter(s => isCollapsedAgent(s, now, selectedKey));
  const shown = liveSeats(seats).filter(s => !folded.includes(s));
  const tabs: TabSpec[] = [...shown.filter(s => !s.isHelper && !s.agentInfo), ...shown.filter(s => s.isHelper), ...shown.filter(s => s.agentInfo)].map(s => ({
    id: s.key,
    label: shortLabel(s),
    title: s.agentInfo ? s.label : s.session,
    close: s.isHelper && !crew.busy,
    closeLabel: s.isHelper ? `Stop ${s.label}` : undefined,
    leading: s.agentInfo ? <AgentDot running={s.agentInfo.state === "running"} /> : <Avatar name={s.brand} size={22} presence={s.presence} surface="var(--v2-bg)" />,
    sub: <>{(s.isHelper || s.agentInfo) && <span className="rounded-sm bg-[var(--v2-sunken)] px-1 text-v2-micro text-[var(--v2-muted)]">{s.agentInfo ? "agent" : "helper"}</span>}<span className="text-v2-small" style={{ color: s.presence === "working" || s.isOrchestrator ? "var(--v2-muted)" : PRESENCE_COLOR[s.presence] }}>{s.isOrchestrator ? "you" : s.words}</span></>,
  }));
  return (
    <Tabs label="Seats" pane="var(--v2-bg)" barClassName="h-[38px] px-5" tabs={tabs} activeId={selectedKey} onSelect={onSelect}
      onClose={key => { const helper = seats.find(s => s.key === key && s.isHelper); if (helper) void crew.stopHelper(helper.agent.slice("helper:".length)); }}
      actions={<>
        {folded.length > 0 && (
          <PopMenu heading="Finished agents" empty="No finished agents"
            items={folded.map(s => ({ id: s.key, label: s.label, sub: s.agentInfo ? `finished ${ago(s.agentInfo.lastActivityMs)}` : undefined, onPick: () => onSelect(s.key) }))}
            trigger={(p, open) => (
              <button type="button" {...p} title={folded.map(s => s.label).join("\n")}
                className="shrink-0 whitespace-nowrap rounded-lg border border-dashed border-[var(--v2-edge-2)] bg-transparent px-2.5 py-1.5 text-v2-body font-medium text-[var(--v2-muted)] hover:text-[var(--v2-text)]"
                data-open={open || undefined}>+{folded.length} finished</button>
            )} />
        )}
        {offline.length > 0 && (
          <PopMenu heading="Offline seats" empty="No offline seats"
            items={offline.map(s => ({ id: s.key, label: `Start ${s.label}`, sub: offlineNote(s), disabledReason: crew.busy ? "Another seat action is running" : null, onPick: () => void crew.start(s.agent) }))}
            trigger={(p, open) => (
              <button type="button" {...p} title={offline.map(s => `${s.label}, ${offlineNote(s)}`).join("\n")}
                className="shrink-0 whitespace-nowrap rounded-lg border border-dashed border-[var(--v2-edge-2)] bg-transparent px-2.5 py-1.5 text-v2-body font-medium text-[var(--v2-muted)] hover:text-[var(--v2-text)]"
                data-open={open || undefined}>+{offline.length} offline</button>
            )} />
        )}
        <PopMenu heading="Add a seat" empty="No agent is installed, enabled and within quota"
          items={crew.available.map(a => ({ id: a.id, label: a.label, sub: `starts ${a.launch}`, disabledReason: crew.busy ? "Another seat action is running" : null, onPick: () => void crew.start(a.id) }))}
          trigger={p => (
            <button type="button" {...p} aria-label="Add a seat" title="Add a seat"
              className="v2-hover inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-[var(--v2-edge-2)] bg-transparent text-[var(--v2-muted)]">
              <Plus size={13} strokeWidth={2.2} aria-hidden />
            </button>
          )} />
      </>}
      end={<>
        <span className="text-v2-small text-[var(--v2-muted)]">{liveCrewSeats(seats).length} seats live</span>
        <Seg label="Layout" options={LAYOUTS} value={layout} onChange={onLayout} />
        <button type="button" aria-pressed={recording} onClick={onRecord}
          title="Record a drill: opens Drill Mode, which stages a disposable project and captures the evidence"
          className="v2-hover inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--v2-edge-2)] bg-transparent px-[9px] py-[5px] text-v2-body font-medium text-[var(--v2-text-2)]">
          <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--v2-bad)]" />Record
        </button>
      </>} />
  );
}
