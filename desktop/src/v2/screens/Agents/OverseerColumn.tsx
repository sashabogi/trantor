// The Overseer column beside the roster: duty seat, autonomy ladder, open episodes, grants, project links (#13992).
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { dutyLogPath, openCode, policyLink, policyUnlink, type HubClient, type Peer } from "../../../shared/api/client";
import { episodeCards, quietEvidence } from "../../../features/overseer/model";
import { lasting } from "../../../shared/rollup";
import { ago } from "../../../shared/presence";
import { Avatar, Button, IconButton, seatLabel } from "../../index";
import { StopConfirm } from "./StopConfirm";
import { AutonomyLadder } from "./AutonomyLadder";
import { SECTION_LABEL } from "./Machines";
import { levelFor } from "./model";
import type { OverseerData } from "./useOverseer";

function Panel({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-[var(--v2-edge)] bg-[var(--v2-panel)] p-3">
      <div className="mb-2 flex items-center"><span className={`${SECTION_LABEL} flex-1`}>{title}</span>{count != null && <span className="text-v2-small text-[var(--v2-muted)]">{count}</span>}</div>
      {children}
    </section>
  );
}

const MUTED = "m-0 text-v2-body text-[var(--v2-muted)]";

function DutyPanel({ ov, peers }: { ov: OverseerData; peers: Peer[] }) {
  const { status, duty } = ov;
  // #14268: Stop duty asks inline first
  const [asking, setAsking] = useState(false);
  if (!status) return <Panel title="Overseer · duty seat"><p className={MUTED}>{ov.error ? `Overseer unavailable: ${ov.error}` : "Reading the watcher..."}</p></Panel>;
  const alive = status.engine && status.lastTickTs > 0 && Date.now() - status.lastTickTs < status.tickMs * 2 + 5000;
  const peer = peers.find(p => p.session === status.dutySession);
  const online = duty?.configured ? duty.online : !!peer && Date.now() - (peer.lastSeen ?? 0) < 5 * 60_000;
  const openLog = () => void ov.run(async () => { await openCode(await dutyLogPath(), "path"); return "opened duty.log"; });
  return (
    <Panel title="Overseer · duty seat">
      <div className="flex items-center gap-2.5">
        {status.dutySession && <Avatar name={status.dutySession} size={28} presence={online ? "ready" : "offline"} surface="var(--v2-panel)" />}
        <div className="min-w-0">
          <div className="truncate text-v2-base font-semibold">{status.dutySession ? seatLabel(status.dutySession) : "no duty seat"}</div>
          <div className="text-v2-body text-[var(--v2-muted)]">
            {alive ? "operating" : status.engine ? "stalled" : "engine missing"} · last sweep {status.lastTickTs ? `${ago(status.lastTickTs)} ago` : "never"}{peer?.model ? ` · ${peer.model}` : ""}
          </div>
        </div>
      </div>
      <p className={`${MUTED} mt-2`}>{duty?.configured ? `${duty.queuedEscalations} queued escalation${duty.queuedEscalations === 1 ? "" : "s"}` : "No duty seat is registered on this hub."}</p>
      <div className="mt-2.5 flex gap-2">
        <Button disabledReason={ov.busy ? "Working..." : null} onClick={openLog}>Open duty log</Button>
        <Button disabledReason={ov.busy ? "Working..." : null} onClick={ov.startDuty}>Start duty</Button>
        <Button variant="danger" disabledReason={ov.busy ? "Working..." : null} onClick={() => setAsking(true)}>Stop duty</Button>
      </div>
      {asking && <StopConfirm name="the duty seat" detail="Its work stays on its branch" busy={ov.busy}
        onStop={() => { setAsking(false); ov.stopDuty(); }} onCancel={() => setAsking(false)} />}
      {ov.notice && <p className={`${MUTED} mt-2`}>{ov.notice}</p>}
    </Panel>
  );
}

function Episodes({ ov, peers }: { ov: OverseerData; peers: Peer[] }) {
  if (!ov.status) return null;
  const open = episodeCards(ov.status, ov.history).filter(e => e.open);
  return (
    <Panel title="Open episodes" count={open.length}>
      {open.length === 0 && <p className={MUTED}>Clear because {quietEvidence(ov.status, peers)}.</p>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {open.map(e => (
          <li key={e.key} className="text-v2-body">
            <div className="break-words">{e.detail || e.kind}</div>
            <div className="text-v2-small text-[var(--v2-muted)]">{e.project} · {lasting(e.first)} · state, not an alarm</div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function LinkForm({ project, ov }: { project: string; ov: OverseerData }) {
  const [other, setOther] = useState("");
  const [reason, setReason] = useState("");
  const ready = !!project && !!other.trim() && !!reason.trim() && other.trim() !== project;
  const submit = () => void ov.run(async () => { const out = await policyLink([project, other.trim()], reason.trim()); setOther(""); setReason(""); return out; });
  const enter = (e: KeyboardEvent) => { if (e.key === "Enter" && ready && !ov.busy) { e.preventDefault(); submit(); } };
  const input = "min-w-0 rounded-lg border border-[var(--v2-edge-2)] bg-[var(--v2-bg)] px-2 py-1 text-v2-body text-[var(--v2-text)]";
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <input aria-label="Link this project to" className={`${input} w-28`} value={other} onChange={e => setOther(e.target.value)} onKeyDown={enter} placeholder="other project" />
      <input aria-label="Reason for the link" className={`${input} flex-1`} value={reason} onChange={e => setReason(e.target.value)} onKeyDown={enter} placeholder="reason" />
      <Button disabledReason={!ready ? "Name another project and a reason" : ov.busy ? "Working..." : null}
        onClick={submit}>+ Link</Button>
    </div>
  );
}

function Links({ ov, project }: { ov: OverseerData; project: string }) {
  const links = ov.status?.links ?? [];
  return (
    <Panel title="Project links">
      {links.length === 0 && <p className={MUTED}>No codependency links declared.</p>}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {links.map(l => (
          <li key={l.projects.join("\0")} className="flex items-center gap-2 text-v2-body">
            <span className="min-w-0 flex-1"><span className="font-medium">{l.projects.join(" ↔ ")}</span> <span className="text-[var(--v2-muted)]">{l.reason || "linked"}</span></span>
            <IconButton label="Unlink" title={`Unlink ${l.projects.join(" and ")}`} size={22} disabled={ov.busy}
              onClick={() => void ov.run(() => policyUnlink(l.projects))}><X size={12} /></IconButton>
          </li>
        ))}
      </ul>
      <LinkForm project={project} ov={ov} />
    </Panel>
  );
}

export function OverseerColumn({ client, project, ov, peers }: { client: HubClient; project: string; ov: OverseerData; peers: Peer[] }) {
  const grants = ov.grants.filter(g => !project || g.project === project || g.project === "*");
  return (
    <aside aria-label="Overseer" className="flex w-full flex-col gap-3 lg:w-[340px] lg:shrink-0">
      <DutyPanel ov={ov} peers={peers} />
      <AutonomyLadder client={client} project={project} level={levelFor(ov.status?.autonomy ?? {}, project)} busy={ov.busy} run={ov.run} />
      <Episodes ov={ov} peers={peers} />
      <Panel title="Grants in force" count={grants.length}>
        {grants.length === 0 && <p className={MUTED}>No approved grants for this project.</p>}
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {grants.map(g => (
            <li key={g.id} className="text-v2-body"><span className="v2-mono text-[var(--v2-muted)]">#{g.id}</span> {g.scope}
              <div className="text-v2-small text-[var(--v2-muted)]">{seatLabel(g.session)} · when {g.condition} · except {g.exclusions}</div></li>
          ))}
        </ul>
      </Panel>
      <Links ov={ov} project={project} />
    </aside>
  );
}
