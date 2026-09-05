import { useState } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import { BrandGlyph } from "../../../shared/Avatar";
import type { AgentStatus } from "./agentSettings";

type AgentCatalogRowProps = {
  agent: AgentStatus;
  busy: boolean;
  onEnabled: (enabled: boolean) => void;
  onDefault: () => void;
};

export function AgentCatalogRow({ agent, busy, onEnabled, onDefault }: AgentCatalogRowProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-agent={agent.id} data-installed={agent.installed} className="py-3.5">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-tr-edge)] bg-black/15">
          <BrandGlyph name={agent.id} size={18} />
        </span>
        <div className="w-28 shrink-0">
          <div className="text-[13px] font-medium">{agent.label}</div>
          <div className="text-[10px] text-[var(--color-tr-muted)]">{agent.installed ? "Installed" : "Available"}</div>
        </div>
        <code className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-tr-muted)]">trantor up {agent.launch}</code>
        <div className="tr-seg grid shrink-0 grid-cols-2 gap-px" aria-label={`${agent.label} availability`}>
          <button type="button" disabled={busy} data-on={agent.enabled} onClick={() => onEnabled(true)}>Enabled</button>
          <button type="button" disabled={busy} data-on={!agent.enabled} onClick={() => onEnabled(false)}>Disabled</button>
        </div>
        {agent.installed ? (
          <button type="button" disabled={busy || !agent.enabled || agent.isDefault} onClick={onDefault}
                  className="tr-input w-24 shrink-0 disabled:opacity-50">
            {agent.isDefault ? "Default" : "Set default"}
          </button>
        ) : (
          <span className="w-24 shrink-0 text-right text-[10px] text-[var(--color-tr-muted)]">Not detected</span>
        )}
        <a href={agent.homepage} target="_blank" rel="noreferrer" aria-label={`${agent.label} documentation`}
           className="text-[var(--color-tr-muted)] hover:text-[var(--color-tr-text)]"><ExternalLink size={13} /></a>
        {agent.installed ? (
          <button type="button" aria-label={`Expand ${agent.label}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
                  className="text-[var(--color-tr-muted)] hover:text-[var(--color-tr-text)]">
            <ChevronRight size={14} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
          </button>
        ) : <span className="w-3.5" />}
      </div>
      {expanded ? (
        <div className="ml-11 mt-3 rounded-lg border border-[var(--color-tr-edge)] bg-black/10 px-3 py-2 text-[11px] text-[var(--color-tr-muted)]">
          <div>Launch command</div>
          <code className="mt-1 block text-[var(--color-tr-text)]">trantor up {agent.launch}</code>
          <div className="mt-2">CLI: <code>{agent.cli}</code></div>
        </div>
      ) : null}
    </div>
  );
}
