// Agents: the roster, the Overseer column, and the harness list, on the 2.0 shell (#13992).
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Overseer } from "../../../features/overseer/Overseer";
import { AgentsPane } from "../../../features/settings/agents/AgentsPane";
import { seatName } from "../../../features/workspace/paneTargets";
import { Button, IconButton, type ScreenProps } from "../../index";
import { walkSiblings } from "../../ui/arrowKeys";
import { useCrew } from "../Workspace/useCrew";
import { RosterTab } from "./RosterTab";
import { OverseerColumn } from "./OverseerColumn";
import { SeatPicker } from "./SeatPicker";
import { headerCounts, noticeSeat } from "./model";
import { useAgentsData } from "./useAgentsData";
import { useOverseer } from "./useOverseer";

const TABS = [
  { id: "roster", label: "Roster" },
  { id: "overseer", label: "Overseer" },
  { id: "harnesses", label: "Harnesses and models" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Header({ project, data, crew }: { project: string; data: ReturnType<typeof useAgentsData>; crew: ReturnType<typeof useCrew> }) {
  const c = headerCounts(data.views);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-v2-heading font-[650]">Agents</h1>
        <div className="text-v2-body text-[var(--v2-muted)]">
          {project || "no project"} · {c.live} live · {c.working} working
          {c.needsYou > 0 && <> · <span className="text-[var(--v2-warn)]">{c.needsYou} needs you</span></>}
          {c.offline > 0 && <> · {c.offline} offline ({c.offlineNames.join(", ")})</>}
        </div>
      </div>
      <SeatPicker crew={crew} trigger={p => (
        <Button variant="primary" {...p} icon={<Plus size={13} />}>Add seat</Button>
      )} />
    </div>
  );
}

export function AgentsScreen({ client, project, onNavigate }: ScreenProps) {
  const [tab, setTab] = useState<TabId>("roster");
  const data = useAgentsData(client);
  const ov = useOverseer(client);
  const crew = useCrew(project, data.refresh);
  // A notice about a seat on this roster belongs on that seat's card; anything else (a start, a catalog failure) shows here.
  const actor = noticeSeat(crew.notice?.text ?? "");
  const claimed = actor !== "" && data.views.some(v => v.project === project && seatName(v.peer.session) === actor);
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-5 py-4">
      <Header project={project} data={data} crew={crew} />
      <div role="tablist" aria-label="Agents sections" className="flex gap-1 border-b border-[var(--v2-edge)]">
        {TABS.map((t, i) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)}
            onKeyDown={e => walkSiblings(e, i, to => { const next = TABS[to]; if (next) setTab(next.id); })}
            className={`border-0 border-b-2 bg-transparent px-3 py-2 text-v2-base ${tab === t.id ? "border-[var(--v2-accent)] text-[var(--v2-text)]" : "border-transparent text-[var(--v2-muted)]"}`}>{t.label}</button>
        ))}
      </div>
      {crew.notice && !claimed && (
        <div role="status" className={`flex items-center gap-2 text-v2-body ${crew.notice.failed ? "text-[var(--v2-bad)]" : "text-[var(--v2-muted)]"}`}>
          <span className="min-w-0 flex-1">{crew.notice.text}</span>
          <IconButton label="Dismiss the seat notice" title="Dismiss" size={20} onClick={crew.dismiss}><X size={11} /></IconButton>
        </div>
      )}
      {data.error && !data.peers && <p className="m-0 text-v2-base text-[var(--v2-bad)]">Agents unavailable: {data.error}</p>}
      {data.peers === null && !data.error && <p className="m-0 text-v2-base text-[var(--v2-muted)]">Loading roster...</p>}
      {tab === "roster" && (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <RosterTab client={client} project={project} data={data} ov={ov} crew={crew} onNavigate={onNavigate} />
          <OverseerColumn client={client} project={project} ov={ov} peers={data.peers ?? []} />
        </div>
      )}
      {tab === "overseer" && <Overseer client={client} />}
      {tab === "harnesses" && <AgentsPane />}
    </div>
  );
}
