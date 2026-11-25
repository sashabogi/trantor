// Autonomy and permissions, in full (#13994): the same dials, scopes and CLI path as classic
// Autonomy.tsx, plus the hub's overseer ladder, in 2.0 chrome.
import { useCallback, useEffect, useState } from "react";
import type { HubClient } from "../../../shared/api/client";
import { Button } from "../../ui/Button";
import { Section } from "../../ui/Section";
import { Seg } from "../../ui/Seg";
import { DialRow } from "./DialRow";
import { AlwaysAsks } from "./PolicyCards";
import { DIALS, autonomyApi, dialBlockedBy, resetPlan, type AutonomyApi, type AutonomyState } from "./autonomyModel";
import { rowMatches } from "./sections";

export type AutonomyPageProps = {
  client: HubClient;
  project: string;
  query: string;
  api?: AutonomyApi;
};

type Scope = "me" | "project";
const ONOFF = [{ value: "off", label: "Off" }, { value: "on", label: "On" }] as const;
const HARNESS = [{ value: "prompt", label: "Ask me" }, { value: "bypass", label: "Skip prompts" }] as const;
const LADDER = [
  { value: "1", label: "1 observe", title: "The overseer only watches and records" },
  { value: "2", label: "2 warn", title: "The overseer tells you when something looks wrong" },
  { value: "3", label: "3 gate", title: "The overseer holds risky steps until you approve" },
  { value: "4", label: "4 auto", title: "The overseer acts on its own within your dials" },
] as const;

export function AutonomyPage({ client, project, query, api = autonomyApi }: AutonomyPageProps) {
  const [scope, setScope] = useState<Scope>("me");
  const target = scope === "project" && project ? project : null;
  const [state, setState] = useState<AutonomyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get(target).then(s => { setState(s); setError(null); }).catch(e => setError(String(e)));
  }, [api, target]);
  useEffect(() => { setState(null); load(); }, [load]);

  const write = async (dial: string, value: string) => {
    setBusy(true);
    try { setState(await api.set(target, dial, value)); setError(null); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const reset = async () => {
    if (!state) return;
    setBusy(true);
    try {
      let last = state;
      for (const w of resetPlan(state)) last = await api.set(target, w.dial, w.value);
      setState(last); setError(null);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-4">
      <ScopeBar scope={scope} project={project} onScope={setScope} />
      {error && <div role="alert" className="text-v2-base text-[var(--v2-bad)]">{error}</div>}
      {!state && !error && <div className="text-v2-base text-[var(--v2-muted)]">reading the dials…</div>}
      {state && <Dials state={state} target={target} query={query} busy={busy} onWrite={write} onReset={reset} />}
      <OverseerLadder client={client} project={project} target={target} query={query} />
      {rowMatches(query, "always asks", "force-push", "irreversible", "launch or quit the app") && <AlwaysAsks />}
      <p className="m-0 text-v2-body text-[var(--v2-muted)]">
        Every change here is written through the trantor CLI, so the rules between dials live in one place.
      </p>
    </div>
  );
}

function ScopeBar({ scope, project, onScope }: { scope: Scope; project: string; onScope: (s: Scope) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-v2-body text-[var(--v2-muted)]">
      Showing
      <Seg label="Scope" value={scope} onChange={onScope} options={[
        { value: "me", label: "Me, all projects", title: "Saved as your default on every project" },
        { value: "project", label: project ? `This project: ${project}` : "This project", title: project ? "Saved as an override for this project only" : "Pin a project to set per-project overrides" },
      ]} />
      {scope === "project" && !project && <span className="text-[var(--v2-warn)]">No project is pinned, so this shows your defaults.</span>}
    </div>
  );
}

type DialsProps = { state: AutonomyState; target: string | null; query: string; busy: boolean; onWrite: (d: string, v: string) => void; onReset: () => void };

function Dials({ state, target, query, busy, onWrite, onReset }: DialsProps) {
  const r = state.resolved;
  const provenance = (key: string) => `now from: ${state.path}${target && state.overridden.includes(key) ? ` · override for ${target}` : target ? " · inherited from your defaults" : ""}`;
  const rows = DIALS.filter(d => rowMatches(query, d.label, d.why, "dials"));
  const showHarness = rowMatches(query, "your session", "ask me", "skip permission prompts", "harness");
  const dirty = resetPlan(state).length > 0;
  return (
    <Section title="The five dials" flush
      sub="Each one can only be as open as the one before it allows. Push needs commit; deploy needs push."
      actions={<Button variant="quiet" onClick={onReset} disabledReason={busy ? "Saving" : dirty ? null : "Already at defaults"}>Reset to defaults</Button>}>
      {rows.map(d => {
        const blocker = dialBlockedBy(d.key, r);
        const blockerLabel = DIALS.find(x => x.key === blocker)?.label;
        return (
          <DialRow key={d.key} label={d.label} why={d.why} choices={ONOFF} value={r[d.key] ? "on" : "off"} changed={r[d.key] !== state.defaults[d.key]}
            busy={busy} blockedNote={blocker ? `Only as open as ${blockerLabel} allows: turn that on first.` : null}
            provenance={provenance(d.key)} onPick={v => onWrite(d.key, v)} />
        );
      })}
      {showHarness && (
        <DialRow label="Your session" why="Whether your own claude asks before it acts." choices={HARNESS} value={r.harness}
          changed={r.harness !== state.defaults.harness} busy={busy} provenance={provenance("harness")}
          note={r.harness === "bypass" ? "Your session will act without asking. It takes effect the next time the session starts." : null}
          onPick={v => onWrite("harness", v)} />
      )}
      {!rows.length && !showHarness && <div className="px-[14px] py-3 text-v2-body text-[var(--v2-muted)]">No dial matches that search.</div>}
    </Section>
  );
}

type LadderProps = { client: HubClient; project: string; target: string | null; query: string };

function OverseerLadder({ client, project, target, query }: LadderProps) {
  const [levels, setLevels] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    client.policy().then(p => { if (alive) setLevels(p.autonomy); }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [client]);
  if (!rowMatches(query, "overseer", "ladder", "observe", "warn", "gate", "auto")) return null;
  const key = target ?? "*";
  const level = levels?.[key] ?? levels?.["*"] ?? 2;
  const pick = (v: string) => {
    const n = Number(v);
    client.setAutonomy(key, n).then(() => setLevels(cur => ({ ...(cur ?? {}), [key]: n }))).catch(e => setError(String(e)));
  };
  return (
    <Section title="Overseer level" flush sub="The overseer's ladder for the hub: 1 observe, 2 warn, 3 gate, 4 auto. Shared with your team.">
      {error && <div role="alert" className="px-[14px] pt-3 text-v2-base text-[var(--v2-bad)]">{error}</div>}
      {!levels && !error && <div className="px-[14px] py-3 text-v2-body text-[var(--v2-muted)]">Policy loads once the hub answers.</div>}
      {levels && (
        <DialRow label={target ? `Overseer: ${project}` : "Overseer: every project"} why="How far the overseer goes on its own before it stops for you."
          choices={LADDER} value={String(level)} changed={key in levels && key !== "*"}
          provenance={key in levels ? `now from: hub policy · ${key === "*" ? "default" : `override for ${key}`}` : "now from: hub policy · inherited default"}
          onPick={pick} />
      )}
    </Section>
  );
}
