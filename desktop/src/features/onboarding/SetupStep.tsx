// "Check your setup": node, the trantor CLI and herdr, each with a status row and, when missing,
// an Install that streams its output live (#14322). Skippable: the wizard's Continue is never gated.
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import type { InstallTarget, SetupApi, SetupReport } from "../../shared/api/client";
import { setupRows } from "./onboardingState";

export function SetupStep({ api, report, onReport, onCliInstalled }: {
  api: SetupApi;
  report: SetupReport | null;
  onReport: (r: SetupReport) => void;
  /** After a successful CLI install: retry the local hub start. */
  onCliInstalled: () => void;
}) {
  const [running, setRunning] = useState<InstallTarget | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const recheck = async () => {
    setChecking(true);
    try { onReport(await api.check()); } catch (e) { setError(String(e)); } finally { setChecking(false); }
  };

  const install = async (target: InstallTarget) => {
    setRunning(target); setLines([]); setError(null);
    const unlisten = await api.onLine(line => setLines(prev => [...prev.slice(-199), line]));
    try {
      const result = await api.install(target);
      if (result.cancelled) setError("Install cancelled.");
      else if (!result.ok) setError(`The ${target} install failed (exit ${result.code ?? "unknown"}).`);
      else if (target === "trantor") onCliInstalled();
    } catch (e) { setError(String(e)); }
    unlisten();
    if (alive.current) { setRunning(null); await recheck(); }
  };

  if (!report) return <div className="tr-card px-4 py-3.5 text-[12.5px]">Checking your setup…</div>;
  return (
    <div className="flex flex-col gap-3">
      <div className="tr-card divide-y divide-[var(--color-tr-edge)]">
        {setupRows(report).map(row => (
          <div key={row.key} data-setup-row={row.key} data-status={row.status} className="flex items-center gap-3 px-4 py-3 text-[12.5px]">
            {row.status === "ok" ? <CheckCircle2 size={15} className="text-tr-ok" /> : <CircleAlert size={15} className="text-[var(--color-tr-warn)]" />}
            <div className="min-w-0 flex-1">
              <div className="font-medium">{row.label}</div>
              <div className="truncate text-[var(--color-tr-muted)]">{row.detail}{row.hint ? `. ${row.hint}` : ""}</div>
            </div>
            {row.install && (
              <button type="button" disabled={running !== null} onClick={() => void install(row.install!)}
                className="rounded-lg bg-tr-doing/20 px-3 py-1 text-[12.5px] font-semibold text-tr-doing hover:bg-tr-doing/30 disabled:opacity-40">
                {running === row.install ? "Installing…" : row.status === "outdated" ? "Update" : "Install"}
              </button>
            )}
          </div>
        ))}
      </div>
      {(running || lines.length > 0) && (
        <pre data-setup-output className="tr-card m-0 max-h-40 overflow-auto px-3 py-2 text-[11.5px] leading-snug">{lines.join("\n") || "Starting…"}</pre>
      )}
      {error && <div role="alert" className="text-[12.5px] text-[var(--color-tr-warn)]">{error}</div>}
      <div className="flex gap-2">
        <button type="button" disabled={checking || running !== null} onClick={() => void recheck()}
          className="rounded-lg border border-[var(--color-tr-edge)] px-3 py-1 text-[12.5px] disabled:opacity-40">Retry</button>
        {running && (
          <button type="button" onClick={() => void api.cancel()}
            className="rounded-lg border border-[var(--color-tr-edge)] px-3 py-1 text-[12.5px]">Cancel</button>
        )}
      </div>
    </div>
  );
}
