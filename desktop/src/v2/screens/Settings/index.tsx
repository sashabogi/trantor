// SETTINGS (#13994): artboard nav, the Autonomy page in full, classic panes re-skinned elsewhere,
// and an honest not-wired line where classic has no equivalent.
import { useEffect, useMemo, useState } from "react";
import type { ScreenProps } from "../../routes";
import { NotWired } from "../../shell/ClassicLenses";
import { Button } from "../../ui/Button";
import { AutonomyPage } from "./AutonomyPage";
import { AboutPage, GeneralPage, NotificationsPage } from "./GeneralPages";
import { WorkingAgreements } from "./PolicyCards";
import { AccountsPage, AgentClisCard, AgentsPage, HubPage, IdentityPage, PhoneCard } from "./SystemPages";
import { SettingsNav } from "./SettingsNav";
import { SECTIONS, filterSections, type SectionId } from "./sections";
import { useSettingsData } from "./useSettingsData";

const NOT_WIRED_LINE = {
  models: "Defaults per job. No model-per-job setting exists on the hub yet.",
  keyboard: "Shortcuts and conflicts. The shortcut map is not readable yet.",
  memory: "What loads into a turn. Memory and rules are not exposed to the app yet.",
  hooks: "What runs on events. Installed hooks are not readable from the app yet.",
  budgets: "Caps per metered provider. Budget limits are not wired yet; balances show in the bottom bar.",
  repository: "Protected branches, merge method and the gate. Not wired yet.",
  worktrees: "Where seats work. Not wired yet.",
  editor: "Font and format on save. Not wired yet; the app to open code in is under General.",
  storage: "Logs, transcripts and cleanup. Not wired yet.",
  drill: "Recorder settings. Drill Mode itself starts from the classic app (Settings, then About); its recorder settings are not wired here yet.",
} satisfies Partial<Record<SectionId, string>>;

function wiredLine(id: SectionId): string {
  const hit = Object.entries(NOT_WIRED_LINE).find(([k]) => k === id);
  return hit ? hit[1] : "Not wired yet.";
}

export function SettingsScreen({ client, project, onNavigate }: ScreenProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SectionId>("autonomy");
  const data = useSettingsData(project);
  const matches = useMemo(() => filterSections(query), [query]);
  // A search that hides the open page moves to its first hit so the right pane never shows a stranger.
  useEffect(() => {
    if (matches.length && !matches.some(s => s.id === active)) setActive(matches[0].id);
  }, [matches, active]);
  const def = SECTIONS.find(s => s.id === active);

  return (
    <div className="flex min-h-0 flex-1">
      <SettingsNav sections={matches} active={active} query={query} onQuery={setQuery} onPick={setActive} />
      <div className="min-w-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto flex max-w-[860px] flex-col gap-4">
          <header>
            <div className="text-[11px] text-[var(--v2-muted)]">{def?.group}</div>
            <h2 className="m-0 text-[20px] font-[650]">{def?.label}</h2>
            <p className="mt-1 text-[12.5px] text-[var(--v2-muted)]">{def?.desc}</p>
          </header>
          <Page id={active} props={{ client, project }} data={data} query={query} onNavigate={onNavigate} />
        </div>
      </div>
    </div>
  );
}

type PageProps = {
  id: SectionId;
  props: Pick<ScreenProps, "client" | "project">;
  data: ReturnType<typeof useSettingsData>;
  query: string;
  onNavigate: ScreenProps["onNavigate"];
};

function Page({ id, props, data, query, onNavigate }: PageProps) {
  switch (id) {
    case "general": return <GeneralPage />;
    case "notifications": return <NotificationsPage />;
    case "accounts": return <AccountsPage project={props.project || data.projects[0] || ""} />;
    case "phone": return <PhoneCard hubBase={data.hubBase} />;
    case "agents": return <AgentsPage />;
    case "autonomy": return (
      <>
        <AutonomyPage client={props.client} project={props.project} query={query} />
        <WorkingAgreements />
        <PhoneCard hubBase={data.hubBase} />
      </>
    );
    case "agreements": return <WorkingAgreements />;
    case "extensions": return (
      <div className="flex items-center gap-3">
        <span className="text-[12.5px] text-[var(--v2-muted)]">Extensions and tools open as their own screen.</span>
        <Button onClick={() => onNavigate("extensions")}>Open Extensions</Button>
      </div>
    );
    case "hub": return <HubPage />;
    case "identity": return <IdentityPage me={data.me} />;
    case "about": return <><AboutPage /><AgentClisCard /></>;
    default: return <NotWired title={SECTIONS.find(s => s.id === id)?.label ?? id} line={wiredLine(id)} />;
  }
}
