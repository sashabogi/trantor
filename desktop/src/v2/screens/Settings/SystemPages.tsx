// Hub, Identity, Phone, Accounts and Agents: the classic panes and probes in 2.0 chrome (#13994).
import { useEffect, useState } from "react";
import { HubClient, hubForProject, knownProjects, type AgentCliCompatibility } from "../../../shared/api/client";
import { AccountsPane } from "../../../features/settings/providers/AccountsPane";
import { AgentsPane } from "../../../features/settings/agents/AgentsPane";
import { PairPhone } from "../../../features/settings/PairPhone";
import { RelayChat } from "../../../features/settings/RelayChat";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { Section } from "../../ui/Section";
import { useAgentCliCompatibility, useAgentCliUpdate, bareVersion } from "../../shell/agentCli";
import { AgentCliSessions } from "../../shell/AgentCliBanner";

type HubRow = { url: string; projects: string[]; ok: boolean | null };

function useHubRows(): HubRow[] {
  const [rows, setRows] = useState<HubRow[]>([]);
  useEffect(() => {
    let alive = true;
    void knownProjects().then(async ps => {
      const byUrl = new Map<string, string[]>();
      for (const p of ps) {
        const u = await hubForProject(p);
        byUrl.set(u, [...(byUrl.get(u) ?? []), p]);
      }
      const next: HubRow[] = [...byUrl.entries()].map(([url, projects]) => ({ url, projects, ok: null }));
      if (!alive) return;
      setRows(next);
      // Reachability is a live fact, so each hub is probed rather than assumed (#13994).
      for (const r of next) {
        new HubClient(r.url).peers()
          .then(() => alive && setRows(cur => cur.map(x => x.url === r.url ? { ...x, ok: true } : x)))
          .catch(() => alive && setRows(cur => cur.map(x => x.url === r.url ? { ...x, ok: false } : x)));
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return rows;
}

export function HubPage() {
  const rows = useHubRows();
  return (
    <Section title="Hub and machines" sub="A project lives on exactly one hub. Pins are written by trantor hub set.">
      <div className="flex flex-col gap-2.5">
        {rows.map(h => (
          <div key={h.url} className="rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] p-3">
            <div className="flex items-center gap-2.5">
              <span className="v2-mono text-v2-base">{h.url.replace(/^https?:\/\//, "")}</span>
              <Chip tone={h.ok === null ? "neutral" : h.ok ? "ok" : "bad"}>{h.ok === null ? "checking" : h.ok ? "reachable" : "unreachable"}</Chip>
              <span className="ml-auto text-v2-small text-[var(--v2-muted)]">{h.url.includes("127.0.0.1") || h.url.includes("localhost") ? "this machine" : "remote"}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">{h.projects.map(p => <Chip key={p} mono>{p}</Chip>)}</div>
          </div>
        ))}
        {!rows.length && <p className="m-0 text-v2-base text-[var(--v2-muted)]">No pins yet. Run trantor hub set &lt;project&gt; &lt;url&gt;</p>}
      </div>
    </Section>
  );
}

export function IdentityPage({ me }: { me: string }) {
  return (
    <Section title="Identity and keys" sub="Every request this app makes is signed as you.">
      <div className="flex items-center gap-4">
        <Avatar name={me || "?"} size={44} />
        <div className="min-w-0 flex-1">
          <div className="text-v2-base font-medium">{me || "reading identity…"}</div>
          <div className="mt-0.5 text-v2-body text-[var(--v2-muted)]">
            The key lives in ~/.agent-bus/keys and never leaves the Rust side; the webview never sees it. Change it with RELAY_OWNER_IDENTITY.
          </div>
        </div>
      </div>
    </Section>
  );
}

export function PhoneCard({ hubBase }: { hubBase: string }) {
  return (
    <Section title="Phone" sub="The companion app enrolls itself from a QR: one invite, single use, ten minutes.">
      <PairPhone hubBase={hubBase} />
      <RelayChat />
    </Section>
  );
}

export function AccountsPage({ project }: { project: string }) {
  return <Section title="Accounts and providers" sub="Provider logins, keys and live connection state. Keys are verified live, then saved to the keychain."><AccountsPane project={project} /></Section>;
}

export function AgentsPage() {
  return <Section title="Agents and harnesses" sub="Installed agents, the default agent and launch commands."><AgentsPane /></Section>;
}

// #14030: a quiet list — the banner is the loud surface. Below the minimum shows here too, but
// as words, never a warning; newer than verified is exactly the line it deserves and no more.
// Slice 2: a below-minimum row carries the same Update button, and the sessions still on the old
// binary are listed here too — the app-start half of the picture, as quiet as the rest.
function stateWords(r: AgentCliCompatibility): string {
  switch (r.state) {
    case "ok": return `within the verified range (${r.minimum}–${r.verifiedUpTo})`;
    case "below_minimum": return `older than Trantor needs (${r.minimum})`;
    case "newer_than_verified": return `newer than the verified range (up to ${r.verifiedUpTo})`;
    default: return r.installed ? "version unreadable" : "not installed";
  }
}

function AgentCliRow({ r }: { r: AgentCliCompatibility }) {
  const update = useAgentCliUpdate(r.cli);
  return (
    <div key={r.cli} data-agent-cli={r.cli}
      className="flex items-center gap-2.5 rounded-lg border border-[var(--v2-edge)] bg-[var(--v2-panel-2)] p-3">
      <span className="text-v2-base font-medium">{r.label}</span>
      <span className="v2-mono text-v2-body text-[var(--v2-muted)]">{r.installed ?? "—"}</span>
      <span className="ml-auto text-v2-small text-[var(--v2-muted)]">{stateWords(r)}</span>
      {r.state === "below_minimum" && r.updateCommand && (
        <Button onClick={update.run} disabledReason={update.busy ? "the updater is running" : null} aria-busy={update.busy || undefined}
          title={`Runs ${r.updateCommand}`}>
          {update.busy ? "Updating" : `Update ${r.label}`}
        </Button>
      )}
      {update.result && <span className="min-w-[180px] max-w-[320px] text-right text-v2-small text-[var(--v2-muted)]"
        title={update.result.output}>
        {update.result.ok
          ? `updated ${bareVersion(update.result.before) ?? "?"} to ${bareVersion(update.result.after) ?? "?"}`
          : "the update did not succeed — see the banner for its output"}
      </span>}
    </div>
  );
}

export function AgentClisCard() {
  const reports = useAgentCliCompatibility();
  return (
    <Section title="Agent CLIs" sub="Each agent CLI's version against the range Trantor has verified.">
      <div className="flex flex-col gap-2.5">
        {reports.map(r => <AgentCliRow key={r.cli} r={r} />)}
        {!reports.length && <p className="m-0 text-v2-base text-[var(--v2-muted)]">Reading installed agent CLIs…</p>}
        {reports.some(r => r.cli === "claude") && <AgentCliSessions cli="claude" />}
      </div>
    </Section>
  );
}
