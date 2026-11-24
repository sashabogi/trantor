// Agents: the roster, the Overseer column, and the harness list, on the 2.0 shell (#13992).
import { useState } from "react";
import { Sparkles, Plus } from "lucide-react";
import { Overseer } from "../../../features/overseer/Overseer";
import { AgentsPane } from "../../../features/settings/agents/AgentsPane";
import { Button, NotWired, type ScreenProps } from "../../index";
import { RosterTab } from "./RosterTab";
import { OverseerColumn } from "./OverseerColumn";
import { headerCounts } from "./model";
import { useAgentsData } from "./useAgentsData";
import { useOverseer } from "./useOverseer";

const TABS = [
  { id: "roster", label: "Roster" },
  { id: "overseer", label: "Overseer" },
  { id: "harnesses", label: "Harnesses and models" },
  { id: "trust", label: "Trust rules" },
  { id: "history", label: "History" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Header({ project, data }: { project: string; data: ReturnType<typeof useAgentsData> }) {
  const c = headerCounts(data.views);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-[20px] font-[650]">Agents</h1>
        <div className="text-[12px] text-[var(--v2-muted)]">
          {project || "no project"} · {c.live} live · {c.working} working
          {c.needsYou > 0 && <> · <span className="text-[var(--v2-warn)]">{c.needsYou} needs you</span></>}
          {c.offline > 0 && <> · {c.offline} offline ({c.offlineNames.join(", ")})</>}
        </div>
      </div>
      <Button icon={<Sparkles size={13} />} disabledReason="Ask the Advisor is not wired yet: the hub has no advisor endpoint for the app">Ask the Advisor</Button>
      <Button variant="primary" icon={<Plus size={13} />} disabledReason="Starting a seat is not wired yet: use the Add a seat panel below, then trantor up">Add seat</Button>
    </div>
  );
}

export function AgentsScreen({ client, project, onNavigate }: ScreenProps) {
  const [tab, setTab] = useState<TabId>("roster");
  const data = useAgentsData(client);
  const ov = useOverseer(client);
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-5 py-4">
      <Header project={project} data={data} />
      <div role="tablist" aria-label="Agents sections" className="flex gap-1 border-b border-[var(--v2-edge)]">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`border-0 border-b-2 bg-transparent px-3 py-2 text-[12.5px] ${tab === t.id ? "border-[var(--v2-accent)] text-[var(--v2-text)]" : "border-transparent text-[var(--v2-muted)]"}`}>{t.label}</button>
        ))}
      </div>
      {data.error && !data.peers && <p className="m-0 text-[12.5px] text-[var(--v2-bad)]">Agents unavailable: {data.error}</p>}
      {data.peers === null && !data.error && <p className="m-0 text-[12.5px] text-[var(--v2-muted)]">Loading roster...</p>}
      {tab === "roster" && (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <RosterTab client={client} project={project} data={data} ov={ov} onNavigate={onNavigate} />
          <OverseerColumn client={client} project={project} ov={ov} peers={data.peers ?? []} />
        </div>
      )}
      {tab === "overseer" && <Overseer client={client} />}
      {tab === "harnesses" && <AgentsPane />}
      {tab === "trust" && <NotWired title="Trust rules" line="Per-seat trust rules are not wired yet. Approved grants show in the Overseer column." />}
      {tab === "history" && <NotWired title="History" line="Seat history is not wired yet." />}
    </div>
  );
}
