// #14030: ONE banner under the top bar when an agent CLI is below Trantor's minimum — installed,
// needed, the reason naming the feature, a copy-the-update-command button (the updater itself is
// never run from the app in this slice) and a dismiss for this session. Every other state stays
// quiet: newer-than-verified and ok show no banner (monitoring doctrine — no repeating nags).
import { useState } from "react";
import type { AgentCliCompatibility } from "../../shared/api/client";
import { Button } from "../ui/Button";
import { useAgentCliCompatibility } from "./agentCli";

function CopyUpdateButton({ report }: { report: AgentCliCompatibility }) {
  const [copied, setCopied] = useState(false);
  if (!report.updateCommand) {
    return <span className="text-[12px] text-[var(--v2-muted)]">update it the way you installed it</span>;
  }
  return (
    <Button
      title={report.updateCommand}
      onClick={() => {
        void navigator.clipboard?.writeText(report.updateCommand ?? "").then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }).catch(() => {});
      }}>
      {copied ? "Copied" : "Copy update command"}
    </Button>
  );
}

function CliBanner({ report, onDismiss }: { report: AgentCliCompatibility; onDismiss: () => void }) {
  return (
    <div role="alert" data-agent-cli-banner={report.cli}
      className="flex items-center gap-3 border-b border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)] px-4 py-2">
      <p className="m-0 min-w-0 flex-1 text-[12.5px] text-[var(--v2-warn)]">
        {report.label} {report.installed} is older than Trantor needs ({report.minimum}): {report.reason}.
      </p>
      <CopyUpdateButton report={report} />
      <button type="button" aria-label={`Dismiss the ${report.label} version banner for this session`}
        onClick={onDismiss}
        className="shrink-0 rounded-lg border-0 bg-transparent p-1.5 text-[14px] leading-none text-[var(--v2-muted)] hover:text-[var(--v2-text)]">
        ×
      </button>
    </div>
  );
}

/** Banners for every agent CLI below Trantor's minimum; nothing for any other state. */
export function AgentCliBanner() {
  const reports = useAgentCliCompatibility();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const below = reports.filter(r => r.state === "below_minimum" && !dismissed.includes(r.cli));
  if (!below.length) return null;
  return <>{below.map(r => <CliBanner key={r.cli} report={r} onDismiss={() => setDismissed(cur => [...cur, r.cli])} />)}</>;
}
