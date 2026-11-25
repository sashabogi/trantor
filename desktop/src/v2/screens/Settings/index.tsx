// SETTINGS (#13994): artboard nav, the Autonomy page in full and classic panes re-skinned elsewhere.
import { useEffect, useMemo, useState } from "react";
import type { ScreenProps } from "../../routes";
import { Button } from "../../ui/Button";
import { AutonomyPage } from "./AutonomyPage";
import { AboutPage, GeneralPage, NotificationsPage } from "./GeneralPages";
import { KeyboardPage } from "./KeyboardPage";
import { WorkingAgreements } from "./PolicyCards";
import { AccountsPage, AgentClisCard, AgentsPage, HubPage, IdentityPage, PhoneCard } from "./SystemPages";
import { SettingsNav } from "./SettingsNav";
import { SECTIONS, filterSections, type SectionId } from "./sections";
import { takeSettingsSection, watchSettingsSection } from "../../shell/settingsIntent";
import { useSettingsData } from "./useSettingsData";

export function SettingsScreen({ client, project, onNavigate }: ScreenProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SectionId>(() => takeSettingsSection() ?? "autonomy");
  // #14204: a page asked for while Settings is already open clears the search so it cannot be hidden.
  useEffect(() => watchSettingsSection(() => {
    const id = takeSettingsSection();
    if (id) { setQuery(""); setActive(id); }
  }), []);
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
            <div className="text-v2-small text-[var(--v2-muted)]">{def?.group}</div>
            <h2 className="m-0 text-v2-heading font-[650]">{def?.label}</h2>
            <p className="mt-1 text-v2-base text-[var(--v2-muted)]">{def?.desc}</p>
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
    case "keyboard": return <KeyboardPage />;
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
        <span className="text-v2-base text-[var(--v2-muted)]">Extensions and tools open as their own screen.</span>
        <Button onClick={() => onNavigate("extensions")}>Open Extensions</Button>
      </div>
    );
    case "hub": return <HubPage />;
    case "identity": return <IdentityPage me={data.me} />;
    case "about": return <><AboutPage /><AgentClisCard /></>;
  }
}
