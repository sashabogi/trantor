import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { SettingsBoundary } from "../SettingsBoundary";
import { AgentCatalogRow } from "./AgentCatalogRow";
import { agentSettingsApi, type AgentSettingsApi, type AgentSettingsStatus } from "./agentSettings";

type AgentsPaneProps = { api?: AgentSettingsApi };

export function AgentsPane(props: AgentsPaneProps) {
  return (
    <SettingsBoundary area="Agents">
      <AgentsPaneContent {...props} />
    </SettingsBoundary>
  );
}

function AgentsPaneContent({ api = agentSettingsApi }: AgentsPaneProps) {
  const [catalog, setCatalog] = useState<AgentSettingsStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try { setCatalog(await api.status()); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const change = async (id: string, action: () => Promise<AgentSettingsStatus>) => {
    setBusy(id); setError("");
    try { setCatalog(await action()); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };

  const installed = catalog?.agents.filter(agent => agent.installed) ?? [];
  const available = catalog?.agents.filter(agent => !agent.installed) ?? [];
  const enabledInstalled = installed.filter(agent => agent.enabled);
  const storedDefault = catalog?.agents.find(agent => agent.isDefault);
  const defaultOptions = storedDefault && !enabledInstalled.some(agent => agent.id === storedDefault.id)
    ? [...enabledInstalled, storedDefault]
    : enabledInstalled;

  return (
    <div>
      <div className="mb-7 border-b border-[var(--color-tr-edge)] pb-5">
        <h2 className="text-[20px] font-semibold">Agents</h2>
        <p className="mt-1 text-[12.5px] text-[var(--color-tr-muted)]">Manage AI agents, set a default, and customize commands.</p>
      </div>
      {error ? <div role="alert" className="tr-card mb-4 px-4 py-3 text-[12px] text-[var(--color-tr-fail)]">Agents unavailable: {error}</div> : null}
      {!catalog ? <div className="tr-card-ghost p-6 text-center text-[13px]">Checking installed agents…</div> : null}
      {catalog ? <>
        <section className="mb-8">
          <h3 className="tr-sec-title">Default Agent</h3>
          <p className="tr-sec-sub">Used when you run <code>trantor up</code> without naming a seat.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" aria-pressed={catalog.default === null} onClick={() => void change("auto", () => api.setDefault(null))}
                    className={`tr-chip ${catalog.default === null ? "text-[var(--color-tr-text)] ring-1 ring-[var(--color-tr-doing)]" : ""}`}>
              {catalog.default === null ? <Check size={11} /> : null} Auto
            </button>
            {defaultOptions.map(agent => (
              <button key={agent.id} type="button" aria-pressed={agent.isDefault} onClick={() => void change(agent.id, () => api.setDefault(agent.id))}
                      className={`tr-chip ${agent.isDefault ? "text-[var(--color-tr-text)] ring-1 ring-[var(--color-tr-doing)]" : ""}`}>
                {agent.isDefault ? <Check size={11} /> : null} {agent.label}
              </button>
            ))}
          </div>
        </section>
        <section className="mb-8">
          <div className="flex items-center gap-2">
            <h3 className="tr-sec-title">Installed</h3>
            <span className="tr-chip">{installed.length} detected</span>
            <button type="button" onClick={() => void load()} aria-label="Refresh agents" className="ml-auto tr-input flex items-center gap-1.5"><RefreshCw size={12} /> Refresh</button>
          </div>
          <div className="mt-2 divide-y divide-[var(--color-tr-edge)]">
            {installed.map(agent => <AgentCatalogRow key={agent.id} agent={agent} busy={busy !== null}
              onEnabled={enabled => void change(agent.id, () => api.setEnabled(agent.id, enabled))}
              onDefault={() => void change(agent.id, () => api.setDefault(agent.id))} />)}
          </div>
        </section>
        <section>
          <div className="flex items-center gap-2"><h3 className="tr-sec-title">Available to install</h3><span className="tr-chip">{available.length} agents</span></div>
          <p className="tr-sec-sub">Install a CLI, then refresh to make it available to your crew.</p>
          <div className="mt-2 divide-y divide-[var(--color-tr-edge)]">
            {available.map(agent => <AgentCatalogRow key={agent.id} agent={agent} busy={busy !== null}
              onEnabled={enabled => void change(agent.id, () => api.setEnabled(agent.id, enabled))}
              onDefault={() => void change(agent.id, () => api.setDefault(agent.id))} />)}
          </div>
        </section>
      </> : null}
    </div>
  );
}
