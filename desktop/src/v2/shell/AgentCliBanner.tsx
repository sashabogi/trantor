// #14030: ONE banner below the minimum — installed, needed, the reason, an Update button (the
// CLI's own updater, only on the operator's click) with a small copy-command beside it, and a
// session dismiss. After a successful update it lists the sessions still on the old binary, one
// confirmed handoff each. All else stays quiet (monitoring doctrine — no repeating nags).
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentCliCompatibility, AgentCliUpdate } from "../../shared/api/client";
import { Button } from "../ui/Button";
import { useAgentCliCompatibility, useAgentCliStaleSessions, useAgentCliUpdate, bareVersion } from "./agentCli";

function copyUpdateCommand(command: string): void {
  void navigator.clipboard?.writeText(command).then(() => {}).catch(() => {});
}

// #14030: the small copy control beside the Update button — the command stays one click away for
// whoever would rather run it in their own terminal.
function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" title={command} data-agent-cli-copy={command}
      onClick={() => {
        copyUpdateCommand(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="shrink-0 rounded-lg border-0 bg-transparent px-1.5 py-0.5 text-[11px] leading-none text-[var(--v2-muted)] underline decoration-dotted underline-offset-2 hover:text-[var(--v2-text)]">
      {copied ? "copied" : "copy command"}
    </button>
  );
}

// #14030: an updater's last lines are the diagnosis; three is a screen, not a log dump.
function lastLines(output: string, count = 3): string {
  return output.trim().split("\n").slice(-count).join("\n").trim();
}

/** The update result as the banner words it: success names both versions, failure shows the
 * updater's last lines and keeps the copy command (#14030). */
export function UpdateOutcomeLine({ report, result }: { report: AgentCliCompatibility; result: AgentCliUpdate }) {
  if (result.ok) {
    return (
      <p className="m-0 min-w-0 flex-1 text-[12.5px] text-[var(--v2-warn)]"
        data-agent-cli-updated={report.cli}>
        Updated {report.label} {bareVersion(result.before) ?? "an unreadable version"} to {bareVersion(result.after) ?? "an unreadable version"}.
      </p>
    );
  }
  return (
    <div className="m-0 min-w-0 flex-1" data-agent-cli-failed={report.cli}>
      <p className="m-0 text-[12.5px] text-[var(--v2-warn)]">The update did not succeed:</p>
      <pre className="m-0 mt-0.5 whitespace-pre-wrap font-mono text-[11.5px] leading-snug text-[var(--v2-muted)]">{lastLines(result.output)}</pre>
    </div>
  );
}

// #14030: one restart, one handoff, after a confirm — the same command and reason the chat
// header's New chat uses; never automatic, never more than the one clicked.
function RestartWithHandoffButton({ project }: { project: string }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restart = () => {
    if (!confirm) { setConfirm(true); return; }
    setBusy(true);
    setError(null);
    invoke<string>("handoff_now", { project, reason: "clicked" })
      .then(() => setDone(true))
      .catch(e => { setError(String(e)); setConfirm(false); })
      .finally(() => setBusy(false));
  };
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Button variant="ghost" onClick={restart} disabledReason={busy ? "the handoff is running" : done ? "already restarted" : null}
        data-restart-handoff={project}
        title={done ? "Handed off to a fresh session" : "Writes a recap, opens a fresh session that takes over"}>
        {done ? "Restarted" : busy ? "Restarting" : confirm ? "Confirm: restart with a handoff" : "Restart with a handoff"}
      </Button>
      {error && <span className="max-w-[220px] truncate text-[11px] text-[var(--v2-bad)]" title={error}>{error}</span>}
    </span>
  );
}

/** #14030 slice 2: the sessions still on the old binary — project, seat, the honest start-time
 * verdict, one restart-through-handoff each (crew seats say where to restart them instead), and a
 * footer naming the machines this machine-local check did not look at. */
export function AgentCliSessions({ cli, refreshKey = 0 }: { cli: string; refreshKey?: number }) {
  const report = useAgentCliStaleSessions(cli, refreshKey);
  const rows = report?.rows ?? [];
  if (!rows.length) return null;
  return (
    <div data-agent-cli-sessions={cli} className="flex flex-col gap-1 border-t border-[var(--v2-warn-edge)] px-4 py-2">
      {rows.map(r => (
        <div key={`${r.project}:${r.seat}`} data-agent-cli-stale={`${r.project}:${r.seat}`}
          className="flex items-center gap-2 text-[12px] text-[var(--v2-warn)]">
          <span className="m-0 min-w-0 flex-1">
            <span className="font-medium">{r.project}</span>
            <span className="text-[var(--v2-muted)]"> · {r.seat} · </span>
            {r.stale === "before_update" ? "started before the update" : "may be on the old version"}
            {r.restart === "agents" && <span className="text-[var(--v2-muted)]"> — restart it from Agents</span>}
          </span>
          {r.restart === "handoff" && <RestartWithHandoffButton project={r.project} />}
        </div>
      ))}
      {!!report?.machinesNotChecked.length && (
        <p className="m-0 text-[11px] text-[var(--v2-muted)]">
          Checked on this machine only — not checked on {report.machinesNotChecked.join(", ")}.
        </p>
      )}
    </div>
  );
}

function CliBanner({ report, onDismiss }: { report: AgentCliCompatibility; onDismiss: () => void }) {
  const update = useAgentCliUpdate(report.cli);
  const updated = update.result?.ok === true;
  return (
    <div role="alert" data-agent-cli-banner={report.cli}
      className="border-b border-[var(--v2-warn-edge)] bg-[var(--v2-warn-soft)]">
      <div className="flex items-center gap-3 px-4 py-2">
        {update.result
          ? <UpdateOutcomeLine report={report} result={update.result} />
          : <p className="m-0 min-w-0 flex-1 text-[12.5px] text-[var(--v2-warn)]">
              {report.label} {report.installed} is older than Trantor needs ({report.minimum}): {report.reason}.
            </p>}
        {!update.result && (report.updateCommand
          ? <>
              <Button variant="primary" onClick={update.run} disabledReason={update.busy ? "the updater is running" : null} aria-busy={update.busy || undefined}
                title={report.updateCommand ? `Runs ${report.updateCommand}` : undefined}>
                {update.busy ? "Updating" : `Update ${report.label}`}
              </Button>
            </>
          : <span className="shrink-0 text-[12px] text-[var(--v2-muted)]">update it the way you installed it</span>)}
        {report.updateCommand && <CopyCommandButton command={report.updateCommand} />}
        <button type="button" aria-label={`Dismiss the ${report.label} version banner for this session`}
          onClick={onDismiss}
          className="shrink-0 rounded-lg border-0 bg-transparent p-1.5 text-[14px] leading-none text-[var(--v2-muted)] hover:text-[var(--v2-text)]">
          ×
        </button>
      </div>
      {updated && <AgentCliSessions cli={report.cli} />}
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
